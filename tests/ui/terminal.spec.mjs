import { test, expect } from '@playwright/test';
import { createWorkspace, joinAs } from './helpers.mjs';

// Needs a Docker daemon: the shell runs inside the workspace container.
test('a personal terminal runs a command and the result reaches the file tree', async ({ browser }) => {
  test.setTimeout(180_000);
  const { inviteToken } = await createWorkspace('UI terminal');
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await joinAs(alice, inviteToken, 'Alice');
  await joinAs(bob, inviteToken, 'Bob');

  await alice.getByRole('button', { name: 'Open my terminal' }).click();
  await expect(alice.locator('.terminal-head')).toContainText('connected', { timeout: 150_000 });

  // "connected" means the server attached a PTY, not that the shell has
  // finished starting. Typing before its first prompt sends keystrokes into a
  // shell that is not reading yet, which is a race a slow machine loses.
  await expect(alice.locator('.terminal-host')).toContainText(/[$#]/, { timeout: 60_000 });

  // xterm reads from a hidden textarea; clicking the container is not enough
  // to give it focus in a headless browser.
  const input = alice.locator('.terminal-host textarea.xterm-helper-textarea');
  await input.focus();
  await input.pressSequentially('echo marker-$((6*7)) > browser-made.txt && cat browser-made.txt');
  await input.press('Enter');

  // A marker the shell has to compute, so the prompt alone cannot satisfy it.
  await expect(alice.locator('.terminal-host')).toContainText('marker-42', { timeout: 60_000 });
  // The other person's file tree picks it up without a reload.
  await expect(bob.getByRole('button', { name: 'browser-made.txt' })).toBeVisible({ timeout: 30_000 });
});
