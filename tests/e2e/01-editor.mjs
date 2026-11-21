// Milestone 1: two tabs edit one file with live cursors, and a refresh keeps it.
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import { API, WS_ORIGIN, call, reporter, sleep, twoPeople } from './lib.mjs';

const { check, finish } = reporter('editor');
const { workspaceId, alice, bob } = await twoPeople('E2E editor');

check('an invite link creates a second, distinct person', bob.user.id !== alice.user.id);
const tree = (await call('GET', `/api/workspaces/${workspaceId}/files`, null, bob.token)).body.tree;
check('a new member can list the files', tree.some((n) => n.path === 'README.md'));
const anonymous = await call('GET', `/api/workspaces/${workspaceId}/files`, null, null);
check('no identity is refused', anonymous.status === 403, `status ${anonymous.status}`);

const open = (token, name) => {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/README.md`, token,
    document: doc, broadcast: false, preserveConnection: false, quiet: true,
  });
  provider.awareness?.setLocalStateField('user', { name, color: '#f00' });
  return { doc, provider, text: doc.getText('content') };
};

const tabA = open(alice.token, 'Alice');
const tabB = open(bob.token, 'Bob');
await sleep(1200);

check('tab A loaded the file from disk', tabA.text.toString().includes('# Shared workspace'));
check('tab B sees the same text', tabB.text.toString() === tabA.text.toString());

const namesSeenByA = [...tabA.provider.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean);
check('cursors carry names between tabs', namesSeenByA.includes('Bob'), namesSeenByA.join(','));

tabA.text.insert(0, 'ALICE-EDIT\n');
tabB.text.insert(tabB.text.length, '\nBOB-EDIT\n');
await sleep(1000);
const merged = tabA.text.toString();
check('concurrent edits both survive', merged.includes('ALICE-EDIT') && merged.includes('BOB-EDIT'));
check('the tabs converge', tabB.text.toString() === merged);

await sleep(1500);
const onDisk = fs.readFileSync(
  path.join(process.cwd(), 'data', 'workspaces', workspaceId, 'README.md'), 'utf8');
check('the debounced write reached disk', onDisk === merged, `${onDisk.length} bytes`);

tabA.provider.destroy();
tabB.provider.destroy();
await sleep(1500);
const reopened = open(alice.token, 'Alice');
await sleep(1200);
check('content survives closing every tab', reopened.text.toString() === merged);
reopened.provider.destroy();

let authFailed = false;
const intruder = new HocuspocusProvider({
  url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/README.md`, token: 'not-a-real-token',
  document: new Y.Doc(), broadcast: false, preserveConnection: false, quiet: true,
  onAuthenticationFailed: () => { authFailed = true; },
});
await sleep(1200);
check('sync rejects an invalid token', authFailed);
intruder.destroy();

await sleep(200);
finish();
