import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  retries: 2,
  timeout: 45_000,
  workers: 2,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // No userAgent override — Cloudflare Bot Fight Mode flagged the
    // "NamaMonitor/1.0" string. Default Chromium UA passes the userAgentCheck.
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
});
