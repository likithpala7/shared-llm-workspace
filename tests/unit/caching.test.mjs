import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnRequest } from '../../server/src/llm.ts';
import { AGENT_TOOLS } from '../../server/src/agentTools.ts';

const turn = () => ({
  system: 'You are the agent inside a shared coding workspace.',
  tools: AGENT_TOOLS,
  messages: [{ role: 'user', content: '[Alice]: add a README' }],
});

test('every request carries a cache breakpoint', () => {
  const request = buildTurnRequest(turn());
  assert.deepEqual(request.cache_control, { type: 'ephemeral' });
});

test('the cached prefix is the expensive part: tools and system', () => {
  const request = buildTurnRequest(turn());
  // The API caches by prefix in the order tools → system → messages, so both
  // of the stable, repeated pieces sit before the conversation.
  assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
  assert.equal(typeof request.system, 'string');
  assert.ok(Array.isArray(request.messages));
});

test('the prefix is identical between steps of one turn', () => {
  // A tool loop appends to messages and resends. Everything before the new
  // material must be byte-identical or the cache misses.
  const first = buildTurnRequest(turn());
  const withToolResult = turn();
  withToolResult.messages = [
    ...withToolResult.messages,
    { role: 'assistant', content: 'calling a tool' },
    { role: 'user', content: 'tool result' },
  ];
  const second = buildTurnRequest(withToolResult);

  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools));
  assert.equal(second.system, first.system);
  assert.equal(
    JSON.stringify(second.messages.slice(0, first.messages.length)),
    JSON.stringify(first.messages),
    'the earlier messages must be resent unchanged',
  );
});

test('the tool list is deterministic, so it never invalidates the cache', () => {
  const a = buildTurnRequest(turn()).tools.map((t) => t.name);
  const b = buildTurnRequest(turn()).tools.map((t) => t.name);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...new Set(a)], 'no duplicate tool definitions');
});

test('nothing volatile is baked into the request', () => {
  // A timestamp or random id anywhere in the prefix would silently break
  // caching on every call.
  const first = JSON.stringify(buildTurnRequest(turn()));
  const second = JSON.stringify(buildTurnRequest(turn()));
  assert.equal(first, second, 'two identical turns must produce identical requests');
});

test('the model and thinking mode are what we expect to be paying for', () => {
  const request = buildTurnRequest(turn());
  assert.equal(request.model, 'claude-opus-5');
  assert.deepEqual(request.thinking, { type: 'adaptive' });
});
