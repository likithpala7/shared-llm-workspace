import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../../server/src/auth.ts';

test('a signed token round-trips', () => {
  assert.equal(verifyToken(signToken('user-123')), 'user-123');
});

test('nothing unsigned is accepted', () => {
  for (const bad of [undefined, null, '', 'user-123', 'user-123.', '.mac', 'user-123.wrongmac']) {
    assert.equal(verifyToken(bad), null, JSON.stringify(bad));
  }
});

test('a token cannot be re-pointed at another user', () => {
  const token = signToken('alice');
  const forged = token.replace(/^alice/, 'bobby');
  assert.equal(verifyToken(forged), null);
});

test('a tampered signature is rejected', () => {
  const token = signToken('alice');
  const [id, mac] = token.split('.');
  const flipped = mac[0] === 'a' ? `b${mac.slice(1)}` : `a${mac.slice(1)}`;
  assert.equal(verifyToken(`${id}.${flipped}`), null);
});

test('user ids containing a dot still verify', () => {
  // The signature is split on the last dot, so ids with dots must survive.
  const id = 'odd.user.id';
  assert.equal(verifyToken(signToken(id)), id);
});

test('two users never share a signature', () => {
  assert.notEqual(signToken('alice').split('.')[1], signToken('bob').split('.')[1]);
});
