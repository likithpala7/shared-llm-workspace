import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../../server/src/summaries.ts';

test('an empty string costs nothing', () => {
  assert.equal(estimateTokens(''), 0);
});

test('the estimate grows with length', () => {
  assert.ok(estimateTokens('a'.repeat(1000)) > estimateTokens('a'.repeat(100)));
});

test('the estimate is in the right order of magnitude for English', () => {
  // ~4 characters per token is the usual rule of thumb.
  const words = 'the quick brown fox jumps over the lazy dog '.repeat(50);
  const estimate = estimateTokens(words);
  assert.ok(estimate > words.length / 6, `${estimate} too low for ${words.length} chars`);
  assert.ok(estimate < words.length / 2, `${estimate} too high for ${words.length} chars`);
});
