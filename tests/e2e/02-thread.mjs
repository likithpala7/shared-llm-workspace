// Milestone 2: two people send at once and get answers one after the other.
import WebSocket from 'ws';
import { WS_ORIGIN, call, lastAnswer, reporter, settle, sleep, thread, twoPeople } from './lib.mjs';
import { requireRealModel } from './lib.mjs';

const { check, finish } = reporter('thread');

await requireRealModel('thread');
const { workspaceId, alice, bob } = await twoPeople('E2E thread');

const watch = (token) => {
  const events = [];
  const socket = new WebSocket(`${WS_ORIGIN}/events`);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', token, workspaceId })));
  socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
  return { socket, events };
};
const aliceFeed = watch(alice.token);
const bobFeed = watch(bob.token);
await sleep(400);

const [first, second] = await Promise.all([
  call('POST', `/api/workspaces/${workspaceId}/ai`, { content: 'Reply with just the word ONE. No tools.' }, alice.token),
  call('POST', `/api/workspaces/${workspaceId}/ai`, { content: 'Reply with just the word TWO. No tools.' }, bob.token),
]);
check('both requests are accepted', first.status === 200 && second.status === 200);

await sleep(400);
let data = await thread(workspaceId, alice.token);
check('the first request runs immediately',
  data.messages.find((m) => m.id === first.body.message.id).status === 'running');
const queued = data.messages.find((m) => m.id === second.body.message.id);
check('the second waits in a visible queue', queued.status === 'queued', queued.status);
check('the queue shows who is waiting', queued.authorName === 'Bob');

data = await settle(workspaceId, alice.token);
const order = data.messages
  .filter((m) => m.kind === 'request' || m.kind === 'assistant')
  .map((m) => `${m.kind}:${m.authorName ?? 'agent'}`);
check('turns ran one after the other, in arrival order',
  JSON.stringify(order) === JSON.stringify(['request:Alice', 'assistant:agent', 'request:Bob', 'assistant:agent']),
  order.join(' | '));

const answers = data.messages.filter((m) => m.kind === 'assistant');
check('the first answer is for Alice', /one/i.test(answers[0].content), answers[0].content.slice(0, 40));
check('the second answer is for Bob', /two/i.test(answers[1].content), answers[1].content.slice(0, 40));

const deltasToBob = bobFeed.events.filter((e) => e.type === 'ai_delta');
check('answers stream to the sender', aliceFeed.events.some((e) => e.type === 'ai_delta'));
check('and to everyone else', deltasToBob.length > 0, `${deltasToBob.length} chunks`);

const third = await call('POST', `/api/workspaces/${workspaceId}/ai`, { content: 'Something long to cancel' }, alice.token);
const fourth = await call('POST', `/api/workspaces/${workspaceId}/ai`, { content: 'Queued behind it' }, bob.token);
await sleep(200);
const wrongPerson = await call('POST', `/api/workspaces/${workspaceId}/ai/${fourth.body.message.id}/cancel`, {}, alice.token);
check("one person cannot cancel another's request", wrongPerson.status === 409, `status ${wrongPerson.status}`);
const ownCancel = await call('POST', `/api/workspaces/${workspaceId}/ai/${fourth.body.message.id}/cancel`, {}, bob.token);
check('a sender can cancel their own queued request', ownCancel.status === 200);

const stopped = await call('POST', `/api/workspaces/${workspaceId}/ai-stop`, {}, bob.token);
check('any member can stop the running turn', stopped.body.stopped === true);

data = await settle(workspaceId, alice.token);
const stoppedAnswer = data.messages.filter((m) => m.kind === 'assistant').at(-1);
check('a stopped answer is marked cancelled', stoppedAnswer.status === 'cancelled', stoppedAnswer.status);
check('a cancelled request never ran',
  data.messages.find((m) => m.id === fourth.body.message.id).status === 'cancelled');

const outsider = await call('GET', `/api/workspaces/${workspaceId}/ai`, null, null);
check('non-members cannot read the thread', outsider.status === 403, `status ${outsider.status}`);

aliceFeed.socket.close();
bobFeed.socket.close();
await sleep(200);
finish();
