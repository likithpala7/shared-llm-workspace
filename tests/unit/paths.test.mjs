import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveInWorkspace, workspaceDir } from '../../server/src/files.ts';

const WS = 'testworkspace';

test('an ordinary relative path resolves inside the workspace', () => {
  const resolved = resolveInWorkspace(WS, 'src/index.ts');
  assert.equal(resolved, path.join(workspaceDir(WS), 'src', 'index.ts'));
});

test('paths that climb out of the workspace are refused', () => {
  for (const attempt of [
    '../secrets.txt',
    '../../etc/passwd',
    'src/../../../../etc/passwd',
    './../../.env',
    'a/b/../../../outside',
  ]) {
    assert.throws(() => resolveInWorkspace(WS, attempt), /escapes workspace/, attempt);
  }
});

test('absolute paths are refused', () => {
  for (const attempt of ['/etc/passwd', '/tmp/x', path.join(workspaceDir(WS), '..', 'other')]) {
    assert.throws(() => resolveInWorkspace(WS, attempt), /escapes workspace|is ignored/, attempt);
  }
});

test('the workspace root itself is not a file', () => {
  assert.throws(() => resolveInWorkspace(WS, '.'), /escapes workspace/);
  assert.throws(() => resolveInWorkspace(WS, ''), /escapes workspace/);
});

test('ignored directories cannot be reached', () => {
  for (const attempt of ['node_modules/evil.js', '.git/config', 'src/node_modules/x', 'a/.git/HEAD']) {
    assert.throws(() => resolveInWorkspace(WS, attempt), /is ignored/, attempt);
  }
});

test('a path that merely starts with the workspace name is still contained', () => {
  const resolved = resolveInWorkspace(WS, 'dotfiles/.envrc');
  assert.ok(resolved.startsWith(workspaceDir(WS) + path.sep), resolved);
});
