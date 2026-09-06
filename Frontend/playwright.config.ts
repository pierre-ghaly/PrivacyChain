import { defineConfig, devices } from '@playwright/test';

// Reuses scripts/dev-up.sh (the same "one command" used for manual dev) rather
// than re-encoding the Hardhat -> deploy -> L2 -> L3 -> seed -> Frontend
// startup order here. See the root README for what that script does.
export default defineConfig({
  testDir: './e2e',
  timeout: 60 * 1000,
  fullyParallel: false, // tests share one seeded chain — order/isolation matters
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3005',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'bash ../scripts/dev-up.sh',
    url: 'http://localhost:3005',
    timeout: 180 * 1000,
    reuseExistingServer: !process.env.CI,
    // Suppresses dev-up.sh's browser auto-open of the MetaMask setup helper —
    // irrelevant and disruptive when the stack is launched for a test run.
    env: { PLAYWRIGHT_TEST: '1' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10 * 1000 },
  },
});
