// App settings that outlive a run, such as whether first-run onboarding is done.
// They live next to Designer's own folder, not in any project.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Settings {
  /** Set once the person finishes or skips the welcome steps. */
  onboardedAt?: string;
  /** How they chose to start: the demo, their own project, or a blank canvas. */
  startedWith?: 'demo' | 'project' | 'blank';
}

export const settingsFile = (workspace: string) => join(workspace, '.designer', 'settings.json');

export async function readSettings(workspace: string): Promise<Settings> {
  try {
    const data = JSON.parse(await readFile(settingsFile(workspace), 'utf8')) as unknown;
    return data && typeof data === 'object' ? (data as Settings) : {};
  } catch {
    return {};
  }
}

export async function writeSettings(workspace: string, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings(workspace)), ...patch };
  const file = settingsFile(workspace);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2));
  return next;
}
