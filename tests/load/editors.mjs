// How does one document behave with a crowd in it?
//
//   EDITORS=20 EDITS=30 node tests/load/editors.mjs
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import fs from 'node:fs';
import path from 'node:path';
import { WS_ORIGIN, call, reporter, sleep, twoPeople } from '../e2e/lib.mjs';

const EDITORS = Number(process.env.EDITORS ?? 15);
const EDITS = Number(process.env.EDITS ?? 20);
const GAP_MS = Number(process.env.GAP_MS ?? 40);

const { check, note, finish } = reporter('load:editors');
const { workspaceId, alice } = await twoPeople('Load editors');

note(`${EDITORS} editors × ${EDITS} edits, ${GAP_MS}ms apart`);

const clients = [];
for (let i = 0; i < EDITORS; i++) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/notes.md`, token: alice.token,
    document: doc, broadcast: false, preserveConnection: false, quiet: true,
  });
  provider.awareness?.setLocalStateField('user', { name: `editor-${i}`, color: '#888' });
  clients.push({ doc, provider, text: doc.getText('content'), id: i });
}

const connectStarted = Date.now();
await sleep(2000 + EDITORS * 60);
check('every editor loaded the document',
  clients.every((c) => c.text.toString().includes('Scratch notes')),
  `${clients.filter((c) => c.text.length > 0).length}/${EDITORS} loaded in ${Date.now() - connectStarted}ms`);

// Each client inserts its own markers at the front, all at once.
const latencies = [];
const started = Date.now();
await Promise.all(clients.map(async (client) => {
  for (let n = 0; n < EDITS; n++) {
    const marker = `«${client.id}.${n}»`;
    const sentAt = Date.now();
    client.text.insert(0, marker);
    // Round-trip: how long until a different client sees it?
    const observer = clients[(client.id + 1) % clients.length];
    while (Date.now() - sentAt < 15000) {
      if (observer.text.toString().includes(marker)) break;
      await sleep(5);
    }
    latencies.push(Date.now() - sentAt);
    await sleep(GAP_MS);
  }
}));
const elapsed = Date.now() - started;

await sleep(3000);

const reference = clients[0].text.toString();
check('every client converged on the same text',
  clients.every((c) => c.text.toString() === reference),
  `${new Set(clients.map((c) => c.text.toString())).size} distinct versions`);

let missing = 0;
let duplicated = 0;
for (const client of clients) {
  for (let n = 0; n < EDITS; n++) {
    const count = reference.split(`«${client.id}.${n}»`).length - 1;
    if (count === 0) missing += 1;
    if (count > 1) duplicated += 1;
  }
}
check('no edit was lost', missing === 0, `${missing} missing of ${EDITORS * EDITS}`);
check('no edit was duplicated', duplicated === 0, `${duplicated} duplicated`);

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))];
note(`propagation p50 ${pct(50)}ms · p95 ${pct(95)}ms · p99 ${pct(99)}ms · max ${latencies.at(-1)}ms`);
note(`${EDITORS * EDITS} edits in ${(elapsed / 1000).toFixed(1)}s (${Math.round((EDITORS * EDITS) / (elapsed / 1000))}/s)`);
check('p95 propagation stays under a second', pct(95) < 1000, `${pct(95)}ms`);

await sleep(2500);
const onDisk = fs.readFileSync(path.join(process.cwd(), 'data', 'workspaces', workspaceId, 'notes.md'), 'utf8');
check('disk matches the editors', onDisk === reference, `${onDisk.length} vs ${reference.length} chars`);

for (const client of clients) client.provider.destroy();
await sleep(500);
finish();
