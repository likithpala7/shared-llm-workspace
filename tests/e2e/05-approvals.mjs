// Milestone 5: the agent asks, either person approves, both see the output.
import WebSocket from 'ws';
import { WS_ORIGIN, call, lastAnswer, reporter, settle, sleep, thread, twoPeople, waitFor } from './lib.mjs';
import { requireRealModel } from './lib.mjs';

const { check, finish } = reporter('approvals');

await requireRealModel('approvals');
const { workspaceId, alice, bob } = await twoPeople('E2E approvals');

const events = [];
const socket = new WebSocket(`${WS_ORIGIN}/events`);
socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', token: bob.token, workspaceId })));
socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
await sleep(400);

await call('POST', `/api/workspaces/${workspaceId}/ai`,
  { content: 'Run the command "echo hello from the sandbox" using run_command.' }, alice.token);
let data = await waitFor(workspaceId, alice.token, (d) => d.toolCalls.some((c) => c.status === 'pending'));
const card = data.toolCalls.find((c) => c.status === 'pending');
check('the agent asks before running anything', Boolean(card), card?.command);
check('the card reaches other members live', events.some((e) => e.type === 'tool_call'));

await call('POST', `/api/workspaces/${workspaceId}/ai`,
  { content: 'Reply with just the word QUEUED. Use no tools.' }, bob.token);
await sleep(800);
data = await thread(workspaceId, alice.token);
check('the queue blocks while a card is pending',
  data.messages.filter((m) => m.kind === 'request').at(-1).status === 'queued');

const outsider = await call('POST', `/api/workspaces/${workspaceId}/tool-calls/${card.id}/approve`, {}, null);
check('a non-member cannot decide', outsider.status === 403, `status ${outsider.status}`);
check('any member can approve, not only the asker',
  (await call('POST', `/api/workspaces/${workspaceId}/tool-calls/${card.id}/approve`, {}, bob.token)).status === 200);
const secondClick = await call('POST', `/api/workspaces/${workspaceId}/tool-calls/${card.id}/deny`, {}, alice.token);
check('a second decision is refused (first click wins)', secondClick.status === 409, `status ${secondClick.status}`);

data = await waitFor(workspaceId, alice.token,
  (d) => d.toolCalls.some((c) => c.id === card.id && c.output.includes('hello from the sandbox')));
const ran = data.toolCalls.find((c) => c.id === card.id);
check('the command ran in the container', ran.output.includes('hello from the sandbox'));
check('the card records who decided', ran.decidedByName === 'Bob', ran.decidedByName);
check('output streamed to everyone', events.some((e) => e.type === 'tool_call_output'));

data = await settle(workspaceId, alice.token, { denyCards: false });
check('the blocked request ran once the card cleared',
  data.messages.filter((m) => m.kind === 'request').every((m) => m.status === 'done'));

await call('POST', `/api/workspaces/${workspaceId}/ai`,
  { content: 'Use run_command to run "rm -rf /workspace/notes.md".' }, bob.token);
data = await waitFor(workspaceId, bob.token, (d) => d.toolCalls.some((c) => c.status === 'pending'));
const destructive = data.toolCalls.find((c) => c.status === 'pending');
check('a destructive command still only asks', Boolean(destructive), destructive?.command);
await call('POST', `/api/workspaces/${workspaceId}/tool-calls/${destructive.id}/deny`, {}, alice.token);

data = await settle(workspaceId, bob.token);
const denied = data.toolCalls.find((c) => c.id === destructive.id);
check('a denied command is recorded as denied', denied.status === 'denied', denied.status);
check('a denied command produces no output', denied.output === '');
check('the model is told, and carries on', lastAnswer(data).length > 0);
const files = (await call('GET', `/api/workspaces/${workspaceId}/files`, null, alice.token)).body.tree;
check('the workspace was never touched', files.some((f) => f.path === 'notes.md'));

socket.close();
await sleep(200);
finish();
