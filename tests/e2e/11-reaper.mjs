// Milestone 8: idle containers must not sit on their memory reservation.
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { WS_ORIGIN, reporter, sleep, twoPeople } from './lib.mjs';

const { check, note, finish } = reporter('reaper');

const docker = (args) => execSync(`docker ${args}`, { encoding: 'utf8' }).trim();
const stateOf = (workspaceId) => {
  try {
    return docker(`inspect -f '{{.State.Status}}' slw-${workspaceId}`).replace(/'/g, '');
  } catch {
    return 'absent';
  }
};

const { workspaceId, alice } = await twoPeople('E2E reaper');

// Open a shell, which starts the container.
const openTerminal = () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_ORIGIN}/terminal`);
    socket.on('open', () =>
      socket.send(JSON.stringify({ type: 'start', token: alice.token, workspaceId, cols: 80, rows: 24 })),
    );
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'ready') resolve(socket);
      if (m.type === 'error') reject(new Error(m.message));
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('shell never started')), 180000);
  });

const shell = await openTerminal();
check('a shell starts the container', stateOf(workspaceId) === 'running', stateOf(workspaceId));

// While someone is attached, it must survive the reaper however idle it looks.
note('waiting past the idle window with a shell still attached…');
await sleep(12000);
check('an attached shell keeps the container alive', stateOf(workspaceId) === 'running', stateOf(workspaceId));

shell.close();
await sleep(1000);
note('shell closed; waiting for the reaper…');

let stoppedAfter = null;
for (let i = 0; i < 60; i++) {
  if (stateOf(workspaceId) !== 'running') { stoppedAfter = i; break; }
  await sleep(1000);
}
check('an idle container is stopped', stoppedAfter !== null, `after ~${stoppedAfter}s of idleness`);
check('stopped, not deleted — its files are untouched', stateOf(workspaceId) === 'exited', stateOf(workspaceId));

// And using it again brings it back.
const second = await openTerminal();
check('the next shell starts it again', stateOf(workspaceId) === 'running', stateOf(workspaceId));
second.close();

await sleep(300);
finish();
