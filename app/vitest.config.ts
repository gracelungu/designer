import { defineConfig } from 'vitest/config';

// Browser tests (test/e2e) need a build and run separately with `npm run test:e2e`.
export default defineConfig({ test: { include: ['test/**/*.test.{ts,mjs}'], exclude: ['test/e2e/**', 'node_modules/**'], testTimeout: 20000 } });
