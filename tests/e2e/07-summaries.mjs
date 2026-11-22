import { API, requireRealModel } from './lib.mjs';
// Point TEST_API at a server started with a small SUMMARY_TOKEN_BUDGET.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (l, ok, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? ` — ${e}` : ''}`); if (!ok) failures++; };
const call = async (m, u, b, t) => {
  const res = await fetch(API + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await res.text(); return { status: res.status, body: x ? JSON.parse(x) : null };
};

await requireRealModel('summaries');
const thread = async (id, t) => (await call('GET', `/api/workspaces/${id}/ai`, null, t)).body;
const ask = async (id, t, content) => {
  await call('POST', `/api/workspaces/${id}/ai`, { content }, t);
  for (let i = 0; i < 1200; i++) {
    const d = await thread(id, t);
    for (const card of d.toolCalls.filter((c) => c.status === 'pending')) {
      await call('POST', `/api/workspaces/${id}/tool-calls/${card.id}/deny`, {}, t);
    }
    if (!d.messages.some((m) => m.status === 'running' || m.status === 'queued')) {
      // The summary runs after the turn; give it a moment to land.
      await sleep(1500);
      return d;
    }
    await sleep(250);
  }
  throw new Error('turn never settled');
};
const answer = (d) => d.messages.filter((m) => m.kind === 'assistant').at(-1).content;

const alice = (await call('POST', '/api/workspaces', { name: 'Summaries', displayName: 'Alice' })).body;
const id = alice.workspace.id;
const bob = (await call('POST', `/api/invites/${alice.workspace.inviteToken}/join`, { displayName: 'Bob', asNewUser: true })).body;

// Two facts, from two different people, early in the conversation.
await ask(id, alice.token, 'Note for later: our deploy script is called ship.sh. Reply with just OK, no tools.');
await ask(id, bob.token, 'Note for later: the staging database is named moonfish. Reply with just OK, no tools.');

let memory = (await call('GET', `/api/workspaces/${id}/summary`, null, alice.token)).body;
check('nothing is summarised while the thread is small', memory.summary === null, `${memory.verbatimTokens} tokens verbatim`);

// Talk until the verbatim history outgrows the budget.
const filler = [
  'Describe in three sentences what a code review checklist might contain. No tools.',
  'List four things a README for a web app usually has. No tools.',
  'In three sentences, explain why integration tests are slower than unit tests. No tools.',
  'Name three common causes of flaky tests, one line each. No tools.',
  'In three sentences, describe what a staging environment is for. No tools.',
];
for (const [index, text] of filler.entries()) {
  await ask(id, index % 2 === 0 ? alice.token : bob.token, text);
  memory = (await call('GET', `/api/workspaces/${id}/summary`, null, alice.token)).body;
  if (memory.summary) break;
}

check('the oldest half gets summarised once the budget is passed', Boolean(memory.summary), `${memory.verbatimMessages} messages verbatim, ~${memory.verbatimTokens} tokens`);
console.log(`      summary so far: ${String(memory.summary).replace(/\n/g, ' ').slice(0, 150)}…`);

const full = await thread(id, alice.token);
check('the thread itself keeps every message', full.messages.length > memory.verbatimMessages, `${full.messages.length} stored vs ${memory.verbatimMessages} verbatim`);
check('the summary names people', /alice|bob/i.test(memory.summary), '');

// The real question: does it still know who said what, from before the cut?
const deployAnswer = answer(await ask(id, bob.token, 'From earlier in this conversation: who told you the name of the deploy script, and what is it called? One line, no tools.'));
check('it still knows the fact from before the summary', /ship\.sh/i.test(deployAnswer), deployAnswer.replace(/\n/g, ' ').slice(0, 90));
check('and who said it', /alice/i.test(deployAnswer), '');

const dbAnswer = answer(await ask(id, alice.token, 'And who mentioned the staging database, and what is it named? One line, no tools.'));
check('the second fact survived too', /moonfish/i.test(dbAnswer), dbAnswer.replace(/\n/g, ' ').slice(0, 90));
check('attributed to the right person', /bob/i.test(dbAnswer), '');

// Summarising must happen between turns, never inside one.
memory = (await call('GET', `/api/workspaces/${id}/summary`, null, alice.token)).body;
const covered = full.messages.find((m) => m.content && memory.summary && m.kind === 'assistant');
check('the conversation still works past the budget', memory.verbatimTokens > 0 && Boolean(memory.summary), `~${memory.verbatimTokens} tokens verbatim now`);

const outsider = await call('GET', `/api/workspaces/${id}/summary`, null, null);
check('the debug view is members-only', outsider.status === 403, `status ${outsider.status}`);

console.log(`\nworkspace: ${id}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
