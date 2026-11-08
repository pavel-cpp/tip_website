import { defineConfig, devices } from '@playwright/test'

// The stack (Postgres, Redis, built SPA embedded in tipd, throwaway database) is started by
// e2e/stack/stack.ts as global setup and torn down afterwards. See e2e/README.md.
const reduced = { reducedMotion: 'reduce' as const }

export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/stack/stack.ts',
  snapshotPathTemplate: '{testDir}/../__snapshots__/{projectName}/{testFilePath}/{arg}{ext}',
  outputDir: './e2e/.output/results',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.02 },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.output/report' }]],
  use: {
    trace: 'retain-on-failure',
    locale: 'ru-RU',
    timezoneId: 'Asia/Tashkent',
    ...reduced,
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone-15', use: { ...devices['iPhone 15'] } },
    { name: 'ipad', use: { ...devices['iPad (gen 11)'] } },
  ],
})
