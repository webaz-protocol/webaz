import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:3173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run pwa',
    cwd: process.cwd(),
    url: 'http://127.0.0.1:3173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: `${process.cwd()}/test-results/pwa-home`,
      WEBAZ_MODE: 'sandbox',
      PORT: '3173',
    },
  },
})
