import { defineConfig, devices } from '@playwright/test';

// The suite runs against a real build: dist/ is what the service worker and the
// asset hashing are built for, and the fixtures are generated next to it. The
// webServer command therefore rebuilds first, so `npm run e2e` is self-contained.
export default defineConfig({
    testDir: 'e2e',
    timeout: 60_000,
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:8897',
        trace: 'retain-on-failure',
    },
    webServer: {
        command:
            'node build.js && node .verify/make-fixtures.mjs && python3 -m http.server 8897 --bind 127.0.0.1 --directory dist',
        url: 'http://127.0.0.1:8897/index.html',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
