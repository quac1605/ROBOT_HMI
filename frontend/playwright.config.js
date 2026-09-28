import { defineConfig } from '@playwright/test';
import { browserLaunchOptions } from '../docs/test/scripts/browser_launch_options.mjs';

export default defineConfig({
  testDir: '../docs/test/browser',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'artifacts/stage6/browser-results.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    locale: 'vi-VN',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
  webServer: process.env.STAGE6_EXTERNAL_SERVER === 'true' ? undefined : {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_ENABLE_STAGE6_TEST_CONTROLS: 'true',
    },
  },
  projects: [{
    name: 'chromium',
    use: {
      browserName: 'chromium',
      launchOptions: browserLaunchOptions(),
    },
  }],
});
