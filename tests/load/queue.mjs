// The AI thread under a pile-on: everyone asks at once.
//
//   REQUESTS=20 node tests/load/queue.mjs
// Run against a stub-provider server so the shape is tested without spending.
import { call, reporter, sleep, thread, twoPeople } from '../e2e/lib.mjs';

const REQUESTS = Number(process.env.REQUESTS ?? 15);

const { check, note, finish } = reporter('load:queue');
const { workspaceId, alice, bob } = await twoPeople('Load queue');

note(`${REQUESTS} requests submitted simultaneously by two people`);

const started = Date.now();
const submitted = await Promise.all(
  Array.from({ length: REQUESTS }, (_, i) =>
    call('POST', `/api/workspaces/${workspaceId}/ai`,
      { content: `Request number ${i}. Reply with just the number ${i}. Use no tools.` },
      i % 2 === 0 ? alice.token : bob.token),
  ),
);
const refused = submitted.filter((r) => r.status !== 200);
check('every request was accepted', refused.length === 0,
  refused.length === 0
    ? `${REQUESTS}/${REQUESTS}`
    : `${refused.length} refused, first was ${refused[0].status}: ${refused[0].body?.error ?? ''}` +
      (refused[0].status === 429 ? ' — raise LIMIT_AI_REQUESTS for this run' : ''));
if (refused.length > 0) finish();

const ids = submitted.map((r) => r.body.message.id);
check('every request got its own id', new Set(ids).size === REQUESTS);

await sleep(600);
let data = await thread(workspaceId, alice.token);
const running = data.messages.filter((m) => m.kind === 'request' && m.status === 'running');
check('exactly one turn runs at a time', running.length === 1, `${running.length} running`);

// Let the whole pile drain.
for (let i = 0; i < 2400; i++) {
  data = await thread(workspaceId, alice.token);
  if (!data.messages.some((m) => m.status === 'queued' || m.status === 'running')) break;
  await sleep(250);
}
const elapsed = Date.now() - started;

const requests = data.messages.filter((m) => m.kind === 'request');
check('every request was answered', requests.length === REQUESTS && requests.every((r) => r.status === 'done'),
  `${requests.filter((r) => r.status === 'done').length}/${REQUESTS} done`);

// Parallel HTTP has no arrival order a client can predict, so the thread may
// hold these in any order. What must hold is that the worker then processed
// them in exactly the order the thread shows, one at a time.
const threadOrder = requests.map((r) => Number(/number (\d+)/.exec(r.content)[1]));
const processedOrder = data.messages
  .filter((m) => m.kind === 'assistant')
  .map((m) => {
    const asked = /you asked: "Request number (\d+)/i.exec(m.content);
    return asked ? Number(asked[1]) : null;
  });
check('every answer says which request it answered', processedOrder.every((n) => n !== null),
  `${processedOrder.filter((n) => n === null).length} unattributable`);
check('the queue processed requests in thread order',
  JSON.stringify(processedOrder) === JSON.stringify(threadOrder),
  processedOrder.join(',') === threadOrder.join(',') ? 'in order' : `thread ${threadOrder.join(',')} vs processed ${processedOrder.join(',')}`);
check('no request was answered twice', new Set(processedOrder).size === REQUESTS);

const answers = data.messages.filter((m) => m.kind === 'assistant');
check('one answer per request', answers.length === REQUESTS, `${answers.length} answers`);
check('no answer is empty', answers.every((a) => a.content.trim().length > 0),
  `${answers.filter((a) => !a.content.trim()).length} empty`);

note(`${REQUESTS} turns drained in ${(elapsed / 1000).toFixed(1)}s (${(elapsed / REQUESTS / 1000).toFixed(2)}s per turn)`);

// Submitted one at a time, arrival order is unambiguous and must be kept.
const sequential = [];
for (let i = 0; i < 5; i++) {
  const r = await call('POST', `/api/workspaces/${workspaceId}/ai`,
    { content: `Sequential number ${i}. Reply with just ${i}. Use no tools.` }, alice.token);
  sequential.push(r.body.message.id);
}
for (let i = 0; i < 2400; i++) {
  data = await thread(workspaceId, alice.token);
  if (!data.messages.some((m) => m.status === 'queued' || m.status === 'running')) break;
  await sleep(250);
}
const sequentialInThread = data.messages
  .filter((m) => m.kind === 'request' && m.content.startsWith('Sequential'))
  .map((m) => m.id);
check('requests sent one at a time keep their exact order',
  JSON.stringify(sequentialInThread) === JSON.stringify(sequential));

finish();
