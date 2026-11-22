// Milestone 3: the agent's edits appear live, including while someone types.
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import { WS_ORIGIN, ask, call, lastAnswer, reporter, sleep, twoPeople } from './lib.mjs';
import { requireRealModel } from './lib.mjs';

const { check, finish } = reporter('tools');

await requireRealModel('tools');
const { workspaceId, alice, bob } = await twoPeople('E2E tools');
const filePath = (name) => path.join(process.cwd(), 'data', 'workspaces', workspaceId, name);

const open = (token) => {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/notes.md`, token,
    document: doc, broadcast: false, preserveConnection: false, quiet: true,
  });
  return { provider, text: doc.getText('content') };
};
const tabA = open(alice.token);
const tabB = open(bob.token);
await sleep(1000);

let data = await ask(workspaceId, alice.token,
  'Create a file called guide.md whose contents are exactly: Hello from the agent');
const created = data.messages.filter((m) => m.kind === 'tool_call' && m.content.startsWith('create_file'));
check('the agent called create_file', created.length > 0, created.map((c) => c.content).join(', '));
check('the file is on disk', fs.existsSync(filePath('guide.md')));
check('with the requested contents',
  fs.readFileSync(filePath('guide.md'), 'utf8').includes('Hello from the agent'));
const tree = (await call('GET', `/api/workspaces/${workspaceId}/files`, null, bob.token)).body.tree;
check('and in everyone’s file tree', tree.some((n) => n.path === 'guide.md'));

// An edit while a person types in the same file.
const typed = [];
let typing = true;
const typist = (async () => {
  for (let i = 0; typing && i < 200; i++) {
    const mark = `T${i} `;
    tabA.text.insert(0, mark);
    typed.push(mark);
    await sleep(250);
  }
})();

data = await ask(workspaceId, bob.token,
  'Add a line at the very end of notes.md that reads exactly: AGENT-LINE-ONE');
typing = false;
await typist;
await sleep(1000);

const edits = data.messages.filter((m) => m.kind === 'tool_call' && m.content.startsWith('edit_file'));
const reads = data.messages.filter((m) => m.kind === 'tool_call' && m.content.startsWith('read_file'));
check('it read the file before editing', reads.length > 0, `${reads.length} reads, ${edits.length} edits`);

const liveA = tabA.text.toString();
check('the edit arrived in the live document', liveA.includes('AGENT-LINE-ONE'));
check('and in the other tab', tabB.text.toString().includes('AGENT-LINE-ONE'));
const counts = typed.map((t) => liveA.split(t).length - 1);
check('every keystroke typed during the turn survived', counts.every((n) => n === 1),
  `${typed.length} insertions, duplicates: ${counts.filter((n) => n > 1).length}`);
check('both tabs agree', tabA.text.toString() === tabB.text.toString());

await sleep(1800);
check('the merged result reached disk', fs.readFileSync(filePath('notes.md'), 'utf8') === tabA.text.toString());

// A model may check before it acts, so the failure can surface either as a
// failed tool result or as the agent saying the file is not there. What must
// not happen is the turn dying.
data = await ask(workspaceId, alice.token, 'Edit the file nope.md: replace "a" with "b".');
const failedTool = data.messages.some((m) => m.kind === 'tool_result' && m.content.startsWith('failed:'));
const saidSo = /no\b.*nope\.md|nope\.md.*(does not|doesn't|isn't|not).*exist|no such file/i.test(lastAnswer(data));
check('a missing file is surfaced, not crashed', failedTool || saidSo,
  failedTool ? 'as a failed tool call' : lastAnswer(data).slice(0, 70));
check('the turn still completed', data.messages.at(-1).status === 'done');

tabA.provider.destroy();
tabB.provider.destroy();
await sleep(300);
finish();
