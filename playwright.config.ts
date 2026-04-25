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
    userAgent: 'NamaMonitor/1.0 (E2E uptime test)',
  },
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
});
