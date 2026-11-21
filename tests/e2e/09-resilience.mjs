// What happens when the server dies, restarts, or loses its container.
//
// This suite runs its own server instances on a scratch data directory, so it
// can kill them without disturbing anything else.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { reporter, sleep } from './lib.mjs';

const { check, note, finish } = reporter('resilience');

const PORT = Number(process.env.RESILIENCE_PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slw-resilience-'));

let child = null;

async function startServer(extraEnv = {}) {
  child = spawn('npx', ['tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ...extraEnv },
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      // not listening yet
    }
  }
  throw new Error('server never came up');
}

async function killServer() {
  if (!child) return;
  // Kill whatever actually holds the port: npx is only a wrapper.
  const { execSync } = await import('node:child_process');
  try {
    // -sTCP:LISTEN matters: a bare `lsof -ti :PORT` also lists our own
    // client sockets, and we would kill this very test process.
    execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' });
  } catch {
    // nothing listening
  }
  child.kill('SIGKILL');
  child = null;
  await sleep(1000);
}

const call = async (method, p, body, token) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

try {
  await startServer();
  const alice = (await call('POST', '/api/workspaces', { name: 'Resilience', displayName: 'Alice' })).body;
  const workspaceId = alice.workspace.id;

  // ---- a restart must not duplicate an open document ---------------------
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://localhost:${PORT}/sync`, name: `${workspaceId}/README.md`, token: alice.token,
    document: doc, broadcast: false, preserveConnection: false, quiet: true,
  });
  const ytext = doc.getText('content');
  await sleep(1500);
  const before = ytext.toString();
  check('a tab has the file open', before.includes('# Shared workspace'), `${before.length} chars`);

  await killServer();
  note('server killed with a tab still connected');
  await startServer();
  await sleep(3000);

  const after = ytext.toString();
  check('the document is not duplicated by a restart', after === before, `${before.length} → ${after.length} chars`);
  check('the file on disk is not duplicated',
    fs.readFileSync(path.join(DATA_DIR, 'workspaces', workspaceId, 'README.md'), 'utf8').length === before.length);
  provider.destroy();

  // ---- the queue survives, the running turn does not ---------------------
  for (const content of ['first', 'second', 'third']) {
    await call('POST', `/api/workspaces/${workspaceId}/ai`, { content }, alice.token);
  }
  await sleep(300);
  let data = (await call('GET', `/api/workspaces/${workspaceId}/ai`, null, alice.token)).body;
  check('one turn is running and the rest are queued',
    data.messages.filter((m) => m.status === 'queued').length >= 1,
    data.messages.map((m) => `${m.kind}/${m.status}`).join(', '));

  // Remember exactly what was in flight, so we can check those rows later.
  const inFlight = data.messages.filter((m) => m.status === 'running').map((m) => m.id);

  await killServer();
  await startServer();
  await sleep(2000);

  data = (await call('GET', `/api/workspaces/${workspaceId}/ai`, null, alice.token)).body;
  // A turn that was interrupted must not still claim to be running. Anything
  // else that is running now is the queue resuming, which is the point.
  const stillRunning = data.messages.filter((m) => inFlight.includes(m.id) && m.status === 'running');
  check('the interrupted turn is not left claiming to run', stillRunning.length === 0,
    data.messages.filter((m) => inFlight.includes(m.id)).map((m) => `${m.kind}/${m.status}`).join(', '));

  for (let i = 0; i < 600; i++) {
    data = (await call('GET', `/api/workspaces/${workspaceId}/ai`, null, alice.token)).body;
    if (!data.messages.some((m) => m.status === 'queued' || m.status === 'running')) break;
    await sleep(500);
  }
  const requests = data.messages.filter((m) => m.kind === 'request');
  check('queued requests resume after a restart',
    requests.filter((r) => r.status === 'done').length >= 2,
    requests.map((r) => r.status).join(', '));
  check('the turn that was interrupted is marked, not left hanging',
    requests.every((r) => r.status !== 'queued' && r.status !== 'running'));

  // ---- a pending approval card cannot outlive the server -----------------
  await killServer();
  await startServer({ APPROVAL_TIMEOUT_MS: '4000' });
  data = (await call('GET', `/api/workspaces/${workspaceId}/ai`, null, alice.token)).body;
  check('no approval card is left pending after a restart',
    data.toolCalls.every((c) => c.status !== 'pending'),
    `${data.toolCalls.length} cards`);

  // ---- the editor still works on the restarted server --------------------
  const doc2 = new Y.Doc();
  const provider2 = new HocuspocusProvider({
    url: `ws://localhost:${PORT}/sync`, name: `${workspaceId}/notes.md`, token: alice.token,
    document: doc2, broadcast: false, preserveConnection: false, quiet: true,
  });
  await sleep(1500);
  doc2.getText('content').insert(0, 'AFTER-RESTART ');
  await sleep(1500);
  check('editing still works after everything',
    fs.readFileSync(path.join(DATA_DIR, 'workspaces', workspaceId, 'notes.md'), 'utf8').startsWith('AFTER-RESTART'));
  provider2.destroy();
  await sleep(300);
} finally {
  await killServer();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

finish();
