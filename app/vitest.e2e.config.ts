import { defineConfig } from 'vitest/config';

// Browser tests of the built UI against a real local server and a stand-in Claude Code.
// Run `npm run build` first.
export default defineConfig({ test: { include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false } });
