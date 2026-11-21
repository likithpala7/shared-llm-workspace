// Abuse and isolation: what happens when someone does not play along.
import WebSocket from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import { API, WS_ORIGIN, call, reporter, sleep, twoPeople } from './lib.mjs';

const { check, finish } = reporter('security');

const one = await twoPeople('E2E security A');
const two = await twoPeople('E2E security B');
const outsider = two.alice; // a real user, but not a member of workspace one.

// ---- path traversal through the HTTP API ---------------------------------
for (const attempt of ['../escaped.txt', '../../etc/passwd', 'src/../../../escaped.txt', '/etc/passwd']) {
  const result = await call('POST', `/api/workspaces/${one.workspaceId}/files`, { path: attempt }, one.alice.token);
  check(`create_file refuses ${attempt}`, result.status === 400, `status ${result.status}`);
}
check('nothing escaped onto the host',
  !fs.existsSync(path.join(process.cwd(), 'data', 'workspaces', 'escaped.txt')) &&
  !fs.existsSync(path.join(process.cwd(), 'data', 'escaped.txt')));

for (const attempt of ['node_modules/x.js', '.git/config']) {
  const result = await call('POST', `/api/workspaces/${one.workspaceId}/files`, { path: attempt }, one.alice.token);
  check(`create_file refuses the ignored path ${attempt}`, result.status === 400, `status ${result.status}`);
}

// ---- a member of one workspace cannot touch another ----------------------
const crossChecks = [
  ['GET', `/api/workspaces/${one.workspaceId}`],
  ['GET', `/api/workspaces/${one.workspaceId}/files`],
  ['GET', `/api/workspaces/${one.workspaceId}/ai`],
  ['GET', `/api/workspaces/${one.workspaceId}/chat`],
  ['GET', `/api/workspaces/${one.workspaceId}/summary`],
  ['POST', `/api/workspaces/${one.workspaceId}/ai`],
  ['POST', `/api/workspaces/${one.workspaceId}/ai-stop`],
  ['POST', `/api/workspaces/${one.workspaceId}/files`],
];
let crossBlocked = 0;
for (const [method, endpoint] of crossChecks) {
  const result = await call(method, endpoint, method === 'POST' ? { content: 'x', path: 'x.txt' } : null, outsider.token);
  if (result.status === 403) crossBlocked += 1;
  else console.log(`      LEAK ${method} ${endpoint} -> ${result.status}`);
}
check('every workspace endpoint refuses a non-member', crossBlocked === crossChecks.length,
  `${crossBlocked}/${crossChecks.length} refused`);

// ---- forged and absent credentials on every channel ----------------------
const forged = `${one.alice.user.id}.notarealsignature`;
check('a forged bearer token is refused',
  (await call('GET', `/api/workspaces/${one.workspaceId}/files`, null, forged)).status === 403);

const syncAttempt = (token, label) => new Promise((resolve) => {
  let failed = false;
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${one.workspaceId}/README.md`, token,
    document: new Y.Doc(), broadcast: false, preserveConnection: false, quiet: true,
    onAuthenticationFailed: () => { failed = true; },
  });
  setTimeout(() => { provider.destroy(); resolve(failed); }, 1500);
});
check('the sync channel refuses a forged token', await syncAttempt(forged));
check('the sync channel refuses another workspace’s member', await syncAttempt(outsider.token));

const socketRefused = (channel, payload) => new Promise((resolve) => {
  const socket = new WebSocket(`${WS_ORIGIN}/${channel}`);
  socket.on('open', () => socket.send(JSON.stringify(payload)));
  socket.on('close', (code) => resolve(code === 1008));
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'error') resolve(true);
    if (m.type === 'history' || m.type === 'ready' || m.type === 'subscribed') resolve(false);
  });
  setTimeout(() => resolve(false), 8000);
});
check('the chat channel refuses a non-member',
  await socketRefused('chat', { type: 'subscribe', token: outsider.token, workspaceId: one.workspaceId }));
check('the events channel refuses a non-member',
  await socketRefused('events', { type: 'subscribe', token: outsider.token, workspaceId: one.workspaceId }));
check('the terminal channel refuses a non-member',
  await socketRefused('terminal', { type: 'start', token: outsider.token, workspaceId: one.workspaceId, cols: 80, rows: 24 }));

// ---- invite tokens are not guessable ------------------------------------
check('an unknown invite token is a 404',
  (await call('GET', '/api/invites/aaaaaaaaaaaaaaaaaaaaaa')).status === 404);

// ---- oversized and malformed input ---------------------------------------
const huge = await call('POST', `/api/workspaces/${one.workspaceId}/ai`, { content: 'x'.repeat(2_000_000) }, one.alice.token);
check('an oversized request is rejected, not swallowed', huge.status >= 400, `status ${huge.status}`);
const empty = await call('POST', `/api/workspaces/${one.workspaceId}/ai`, { content: '   ' }, one.alice.token);
check('an empty request is rejected', empty.status === 400, `status ${empty.status}`);

const stillAlive = await call('GET', `/api/workspaces/${one.workspaceId}/files`, null, one.alice.token);
check('the server is still healthy after all that', stillAlive.status === 200);

// ---- files that must never enter a Yjs document --------------------------
const workspacePath = path.join(process.cwd(), 'data', 'workspaces', one.workspaceId);
fs.writeFileSync(path.join(workspacePath, 'big.txt'), 'x'.repeat(1024 * 1024 + 10));
fs.writeFileSync(path.join(workspacePath, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
const tree = (await call('GET', `/api/workspaces/${one.workspaceId}/files`, null, one.alice.token)).body.tree;
check('a file over 1 MB is listed but not editable',
  tree.find((n) => n.path === 'big.txt')?.editable === false);
check('a binary file is listed but not editable',
  tree.find((n) => n.path === 'logo.png')?.editable === false);

const bigOpen = await new Promise((resolve) => {
  let failed = false;
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${one.workspaceId}/big.txt`, token: one.alice.token,
    document: new Y.Doc(), broadcast: false, preserveConnection: false, quiet: true,
    onAuthenticationFailed: () => { failed = true; },
  });
  setTimeout(() => { provider.destroy(); resolve(failed); }, 1500);
});
check('sync refuses to open an oversized file', bigOpen);

await sleep(200);
finish();
