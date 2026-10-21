import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5180'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'webkit-iphone15',
      use: { ...devices['iPhone 15'] },
    },
  ],

  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 5180',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
  },
})
