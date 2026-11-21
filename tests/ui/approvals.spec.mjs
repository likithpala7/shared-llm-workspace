import { test, expect } from '@playwright/test';
import { createWorkspace, joinAs } from './helpers.mjs';

test('a command the agent wants to run is approved by the other person', async ({ browser }) => {
  const { inviteToken } = await createWorkspace('UI approvals');
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await joinAs(alice, inviteToken, 'Alice');
  await joinAs(bob, inviteToken, 'Bob');

  // Alice asks; the card must appear for Bob, who did not ask.
  await alice.getByPlaceholder(/Ask the agent/).fill('Please run the command "echo approved-in-the-browser"');
  await alice.getByPlaceholder(/Ask the agent/).press('Enter');

  const bobCard = bob.locator('.approval');
  await expect(bobCard).toBeVisible({ timeout: 30_000 });
  await expect(bobCard.locator('.approval-command')).toHaveText('echo approved-in-the-browser');
  await expect(bobCard.locator('.approval-status')).toHaveText(/waiting/);
  await expect(bob.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Alice sees the same card, and the Stop button while the turn is held.
  await expect(alice.locator('.approval-command')).toHaveText('echo approved-in-the-browser');

  await bob.getByRole('button', { name: 'Approve' }).click();

  // Both see who decided it, and the output.
  for (const page of [alice, bob]) {
    await expect(page.locator('.approval-status')).toHaveText(/approved by Bob/, { timeout: 30_000 });
    await expect(page.locator('.approval-output')).toContainText('approved-in-the-browser', { timeout: 30_000 });
  }

  // The buttons are gone once decided.
  await expect(bob.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('a denied command reports back and runs nothing', async ({ browser }) => {
  const { inviteToken } = await createWorkspace('UI denial');
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await joinAs(alice, inviteToken, 'Alice');
  await joinAs(bob, inviteToken, 'Bob');

  await alice.getByPlaceholder(/Ask the agent/).fill('Please run the command "rm -rf /workspace/notes.md"');
  await alice.getByPlaceholder(/Ask the agent/).press('Enter');

  await expect(bob.locator('.approval')).toBeVisible({ timeout: 30_000 });
  await bob.getByRole('button', { name: 'Deny' }).click();

  await expect(alice.locator('.approval-status')).toHaveText(/denied by Bob/, { timeout: 30_000 });
  await expect(alice.locator('.approval-output')).toHaveCount(0);
  // The file it wanted to delete is still in the tree.
  await expect(alice.getByRole('button', { name: 'notes.md' })).toBeVisible();
});
