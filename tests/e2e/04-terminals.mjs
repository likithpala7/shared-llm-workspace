// Milestone 4: a shell each, and terminal changes reaching the editor.
import WebSocket from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import { WS_ORIGIN, call, reporter, sleep, twoPeople } from './lib.mjs';

const { check, note, finish } = reporter('terminals');
const { workspaceId, alice, bob } = await twoPeople('E2E terminals');
const filePath = (name) => path.join(process.cwd(), 'data', 'workspaces', workspaceId, name);

const openTerminal = (token, label) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${WS_ORIGIN}/terminal`);
  const term = { socket, text: '', label };
  const timer = setTimeout(() => reject(new Error(`${label}: never became ready`)), 240000);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'start', token, workspaceId, cols: 80, rows: 24 })));
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'output') term.text += m.data;
    if (m.type === 'status') note(`[${label}] ${m.message}`);
    if (m.type === 'ready') { clearTimeout(timer); resolve(term); }
    if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
  });
  socket.on('error', reject);
});
const run = async (term, command, waitMs = 2500) => {
  term.text = '';
  term.socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
  await sleep(waitMs);
  return term.text;
};

const aliceTerm = await openTerminal(alice.token, 'alice');
const bobTerm = await openTerminal(bob.token, 'bob');
check('each person gets a shell', true);

let out = await run(aliceTerm, 'echo "in $(pwd)"');
check('the shell runs in /workspace in the container', /in \/workspace/.test(out));

await run(aliceTerm, 'ALICE_ONLY=1; echo set');
const bobSees = await run(bobTerm, 'echo "alice_var=[$ALICE_ONLY]"');
check('the shells are separate', /alice_var=\[\]/.test(bobSees));
check('each shell keeps its own state', /mine=\[1\]/.test(await run(aliceTerm, 'echo "mine=[$ALICE_ONLY]"')));

await run(bobTerm, 'echo "written by bob" > from-terminal.txt');
await sleep(1200);
check('a file made in a terminal lands on the host', fs.existsSync(filePath('from-terminal.txt')));
check('the other shell sees it too', /written by bob/.test(await run(aliceTerm, 'cat from-terminal.txt')));
const tree = (await call('GET', `/api/workspaces/${workspaceId}/files`, null, alice.token)).body.tree;
check('and it appears in the file tree', tree.some((n) => n.path === 'from-terminal.txt'));

const doc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/notes.md`, token: alice.token,
  document: doc, broadcast: false, preserveConnection: false, quiet: true,
});
const ytext = doc.getText('content');
await sleep(1200);
const before = ytext.toString();

await run(bobTerm, "printf 'LINE-FROM-TERMINAL\\n' >> notes.md", 3000);
await sleep(2500);
check('a terminal edit reaches the open editor', ytext.toString().includes('LINE-FROM-TERMINAL'),
  `${before.length} → ${ytext.length} chars`);

// The formatter case from the spec's risk table: rewrite while someone types.
await run(bobTerm, "printf 'const a = 1\\nconst b = 2\\nconst c = 3\\n' > code.txt", 2000);
await sleep(1500);
const codeDoc = new Y.Doc();
const codeProvider = new HocuspocusProvider({
  url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/code.txt`, token: alice.token,
  document: codeDoc, broadcast: false, preserveConnection: false, quiet: true,
});
const codeText = codeDoc.getText('content');
await sleep(1200);

bobTerm.socket.send(JSON.stringify({ type: 'input', data: 'for i in 1 2 3 4 5 6; do sed -i "s/= [0-9]*/= $i/g" code.txt; sleep 0.9; done\r' }));
const marks = [];
for (let i = 0; i < 20; i++) {
  const mark = `/*t${i}*/`;
  codeText.insert(0, mark);
  marks.push(mark);
  await sleep(250);
}
await sleep(4000);

const finalText = codeText.toString();
const counts = marks.map((m) => finalText.split(m).length - 1);
check('typing survives a formatter rewriting the file', counts.every((n) => n === 1),
  `${marks.length} insertions, duplicates: ${counts.filter((n) => n > 1).length}, lost: ${counts.filter((n) => n === 0).length}`);
check("the formatter's own change is visible", /= 6/.test(finalText));
check('nothing was duplicated', (finalText.match(/const a/g) ?? []).length === 1);

await sleep(2000);
check('editor and disk converge', fs.readFileSync(filePath('code.txt'), 'utf8') === codeText.toString());

provider.destroy();
codeProvider.destroy();
aliceTerm.socket.close();
bobTerm.socket.close();
await sleep(400);
finish();
