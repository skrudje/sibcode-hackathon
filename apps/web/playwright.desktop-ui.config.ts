import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'desktop-ui.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5182',
    viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.E2E_BROWSER_PATH || undefined },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5182',
    url: 'http://127.0.0.1:5182',
    reuseExistingServer: false,
  },
})
