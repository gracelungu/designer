import { defineConfig } from 'vitest/config';

// Browser smoke tests: they need the built UI (npm run build) and Playwright with Chromium.
export default defineConfig({ test: { include: ['test/ui/**/*.ui.ts'], testTimeout: 60000, hookTimeout: 60000 } });
