import { test, expect } from '@playwright/test';
import { createWorkspace, joinAs, postRequest } from './helpers.mjs';

/**
 * Enough text that the thread cannot possibly fit its column. Short filler
 * does not exercise anything: an unconstrained layout only misbehaves once
 * its content is taller than the window.
 */
const LONG = 'This is filler text for a request that needs to be long enough that the thread column overflows several times over. '.repeat(26);

test.describe('layout', () => {
  test('the page never scrolls, however long the thread gets', async ({ page }) => {
    const { workspaceId, inviteToken, owner } = await createWorkspace('UI layout');
    await joinAs(page, inviteToken, 'Alice');

    // Fill the thread with enough to overflow the column several times over.
    for (let i = 0; i < 4; i++) {
      await postRequest(workspaceId, owner.token, `Filler ${i}. ${LONG}`);
    }
    await expect(page.locator('.msg-request')).toHaveCount(4, { timeout: 60_000 });
    // Confirm the premise: there really is more content than the window.
    const contentHeight = await page.locator('.thread-messages').evaluate((el) => el.scrollHeight);
    expect(contentHeight, 'the filler must exceed the window').toBeGreaterThan(900);

    const scroll = await page.evaluate(() => ({
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      bodyScrolls: document.body.scrollHeight > document.body.clientHeight + 1,
      layoutHeight: document.querySelector('.layout').clientHeight,
      viewport: document.documentElement.clientHeight,
    }));
    expect(scroll.pageScrolls, 'the document must not grow past the window').toBe(false);
    expect(scroll.bodyScrolls).toBe(false);
    expect(Math.abs(scroll.layoutHeight - scroll.viewport)).toBeLessThan(2);
  });

  test('every message is reachable by scrolling the pane, and only the pane', async ({ page }) => {
    const { workspaceId, inviteToken, owner } = await createWorkspace('UI scroll');
    await joinAs(page, inviteToken, 'Alice');
    for (let i = 0; i < 4; i++) {
      await postRequest(workspaceId, owner.token, `Filler ${i}. ${LONG}`);
    }
    await expect(page.locator('.msg-request')).toHaveCount(4, { timeout: 60_000 });

    const list = page.locator('.thread-messages');
    expect(
      await list.evaluate((el) => el.scrollHeight > el.clientHeight),
      'the thread list must be the thing that scrolls',
    ).toBe(true);

    // The failure this guards against is not "the page scrolls" — an ancestor
    // may clip instead, which keeps the page still while putting content out
    // of reach. So: scroll the pane and require the content to actually come
    // into view.
    const reach = async (position) => {
      await list.evaluate((el, pos) => { el.scrollTop = pos === 'top' ? 0 : el.scrollHeight; }, position);
      await page.waitForTimeout(150);
      return page.evaluate(() => {
        const messages = [...document.querySelectorAll('.thread-messages .msg')];
        const target = messages.at(-1).getBoundingClientRect();
        const first = messages[0].getBoundingClientRect();
        return {
          lastVisible: target.top < window.innerHeight && target.bottom > 0,
          firstVisible: first.top < window.innerHeight && first.bottom > 0,
          pageTop: document.documentElement.scrollTop,
          sidebarOnScreen: document.querySelector('.sidebar').getBoundingClientRect().top >= 0,
          composerOnScreen:
            document.querySelector('.thread-form').getBoundingClientRect().bottom <= window.innerHeight + 1,
        };
      });
    };

    const atBottom = await reach('bottom');
    expect(atBottom.lastVisible, 'the newest message must be reachable').toBe(true);
    expect(atBottom.pageTop, 'scrolling the pane must not move the page').toBe(0);
    expect(atBottom.composerOnScreen, 'the composer must stay on screen').toBe(true);

    const atTop = await reach('top');
    expect(atTop.firstVisible, 'the oldest message must be reachable').toBe(true);
    expect(atTop.pageTop).toBe(0);
    expect(atTop.sidebarOnScreen, 'the sidebar must stay put').toBe(true);
  });

  test('both panes are reachable as tabs, and neither is a sliver', async ({ page }) => {
    const { inviteToken } = await createWorkspace('UI tabs');
    await joinAs(page, inviteToken, 'Alice');

    await expect(page.getByRole('tab', { name: 'AI thread' })).toBeVisible();
    const chatTab = page.getByRole('tab', { name: /Team chat/ });
    await expect(chatTab).toBeVisible();

    await expect(page.locator('.thread')).toBeVisible();
    await expect(page.locator('.chat')).toHaveCount(0);

    await chatTab.click();
    const chat = page.locator('.chat');
    await expect(chat).toBeVisible();
    await expect(page.locator('.thread')).toHaveCount(0);

    // The bug that hid team chat: a pane rendered into a 7px grid row.
    const box = await chat.boundingBox();
    expect(box.height, 'the open pane must fill the column, not a sliver').toBeGreaterThan(300);
    await expect(page.getByPlaceholder('Message the team…')).toBeVisible();

    await page.getByRole('tab', { name: 'AI thread' }).click();
    await expect(page.locator('.thread')).toBeVisible();
  });
});
