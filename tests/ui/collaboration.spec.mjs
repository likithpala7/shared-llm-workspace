import { test, expect } from '@playwright/test';
import { createWorkspace, joinAs } from './helpers.mjs';

test.describe('two people in one workspace', () => {
  test('typing, the file tree and presence all keep up', async ({ browser }) => {
    const { inviteToken } = await createWorkspace('UI collaboration');

    // Separate contexts, so each tab is genuinely a different person.
    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();
    await joinAs(alice, inviteToken, 'Alice');
    await joinAs(bob, inviteToken, 'Bob');

    // Presence: each sees the other online.
    await expect(alice.locator('.members .online', { hasText: 'Bob' })).toBeVisible();
    await expect(bob.locator('.members .online', { hasText: 'Alice' })).toBeVisible();

    // Typing in one editor reaches the other.
    await alice.locator('.editor-host').click();
    await alice.keyboard.press('End');
    await alice.keyboard.type(' ALICE-TYPED-THIS');
    await expect(bob.locator('.editor-host')).toContainText('ALICE-TYPED-THIS');

    // And Bob's cursor is drawn in Alice's editor, labelled.
    await bob.locator('.editor-host').click();
    await bob.keyboard.type('X');
    await expect(alice.locator('[class*="yRemoteSelectionHead-"]')).toHaveCount(1);
    // The caret is drawn from awareness state, and the stylesheet carrying its
    // name is injected when that state arrives — so the label can trail the
    // caret by a frame. Poll rather than read once.
    await expect
      .poll(
        () =>
          alice
            .locator('[class*="yRemoteSelectionHead-"]')
            .evaluate((el) => getComputedStyle(el, '::after').content),
        { message: "the remote cursor should be labelled with its owner's name" },
      )
      .toContain('Bob');

    // A file created by one appears in the other's tree without a reload.
    alice.once('dialog', (dialog) => dialog.accept('from-alice.md'));
    await alice.getByRole('button', { name: '+ new' }).click();
    await expect(bob.getByRole('button', { name: 'from-alice.md' })).toBeVisible();
  });

  test('team chat delivers, and the hidden tab shows an unread count', async ({ browser }) => {
    const { inviteToken } = await createWorkspace('UI chat');
    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();
    await joinAs(alice, inviteToken, 'Alice');
    await joinAs(bob, inviteToken, 'Bob');

    await bob.getByRole('tab', { name: /Team chat/ }).click();
    await bob.getByPlaceholder('Message the team…').fill('are you seeing this?');
    await bob.getByPlaceholder('Message the team…').press('Enter');

    // Alice is on the AI thread, so the chat tab should mark it unread.
    await expect(alice.locator('.pane-tab', { hasText: 'Team chat' }).locator('.pane-badge')).toHaveText('1');

    await alice.getByRole('tab', { name: /Team chat/ }).click();
    await expect(alice.locator('.chat-msg')).toContainText('are you seeing this?');
    await expect(alice.locator('.chat-msg .chat-author')).toHaveText('Bob');

    // Reading it clears the badge.
    await expect(alice.locator('.pane-badge')).toHaveCount(0);

    // And the agent is told, in the UI, that it cannot see this.
    await expect(alice.locator('.chat .pane-meta', { hasText: 'the agent never sees this' })).toBeVisible();
  });
});
