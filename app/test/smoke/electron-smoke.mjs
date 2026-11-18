#!/usr/bin/env node
// Starts the Mac app (or the dev Electron build) headless and checks it comes up:
// the window loads the UI, first-run onboarding shows, the native bridge and
// updater answer, and the bundled demo project is found. Then it quits.
//
//   node test/smoke/electron-smoke.mjs                          # dev build (run `npm run build` first)
//   node test/smoke/electron-smoke.mjs release/mac-arm64/Designer.app/Contents/MacOS/Designer
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packaged = process.argv[2];
const electron = packaged ?? createRequire(import.meta.url)('electron');
const args = packaged ? [] : [appDir];
if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');

const tmp = mkdtempSync(join(tmpdir(), 'designer-smoke-'));
const env = { ...process.env, DESIGNER_SMOKE_TEST: '1', DESIGNER_WORKSPACE: join(tmp, 'workspace'), DESIGNER_USER_DATA: join(tmp, 'user-data'), ELECTRON_ENABLE_LOGGING: '0' };

let cmd = electron;
let cmdArgs = args;
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY;
if (needsDisplay && spawnSync('which', ['xvfb-run']).status === 0) {
  cmd = 'xvfb-run';
  cmdArgs = ['-a', electron, ...args];
}

const child = spawn(cmd, cmdArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const timer = setTimeout(() => {
  console.error('Smoke test timed out after 90s\n' + out);
  child.kill('SIGKILL');
}, 90000);
child.on('exit', (code) => {
  clearTimeout(timer);
  rmSync(tmp, { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('SMOKE_'));
  if (code === 0 && line?.startsWith('SMOKE_OK')) {
    console.log(line);
    process.exit(0);
  }
  console.error(`Smoke test failed (exit ${code})\n${out}`);
  process.exit(1);
});
