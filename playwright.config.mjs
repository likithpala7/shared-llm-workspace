import { defineConfig } from '@playwright/test';

/**
 * Browser tests run against a server you have already started. The layout
 * failures this project has had were all visual — a pane that stopped
 * scrolling, a tab in a 7px slot — so these drive a real browser rather than
 * asserting on the DOM from the outside.
 */
export default defineConfig({
  testDir: './tests/ui',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: process.env.TEST_URL ?? 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
});
