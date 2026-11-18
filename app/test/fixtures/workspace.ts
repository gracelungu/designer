import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A Designer workspace that has already been through the first-run welcome, so tests land on the canvas. */
export function onboardedWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'designer-ws-'));
  mkdirSync(join(ws, '.designer'), { recursive: true });
  writeFileSync(join(ws, '.designer', 'settings.json'), JSON.stringify({ onboardedAt: new Date().toISOString() }));
  return ws;
}
