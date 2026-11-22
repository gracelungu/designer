import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProposalCheck, ProposalPlan, RecipeCommand, VisualShot } from '../shared/protocol.js';
import { DevProcess } from './project.js';
import { readRecipe, substitutePort } from './runner.js';
import { freePort } from './setup.js';
import { diffPng, type Shooter } from './visual.js';

export const contentHash = (value: string) => createHash('sha256').update(value).digest('hex');

function command(value: unknown): RecipeCommand | undefined {
  if (!value || typeof value !== 'object') return;
  const { command, cwd } = value as Partial<RecipeCommand>;
  if (typeof command !== 'string' || !command.trim() || command.length > 2000) return;
  if (cwd !== undefined && (typeof cwd !== 'string' || isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..'))) return;
  return { command: command.trim(), cwd: cwd || '.' };
}

export async function planProposal(project: string, answer: string): Promise<{ summary: string; plan: ProposalPlan }> {
  const match = /(?:^|\n)```designer-review[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(answer);
  let proposed: Partial<Record<keyof ProposalPlan, unknown>> = {};
  if (match && match[1].length < 20_000) {
    try { proposed = JSON.parse(match[1]) ?? {}; } catch { /* use the saved project recipe */ }
  }
  const saved = await readRecipe(project);
  const commands = (list: unknown, limit: number) => Array.isArray(list)
    ? list.slice(0, limit).map(command).filter((value): value is RecipeCommand => !!value) : [];
  const preview = command(proposed.preview) ?? command(saved?.app);
  const routes = Array.isArray(proposed.routes) ? proposed.routes.filter((route): route is string =>
    typeof route === 'string' && route.startsWith('/') && !route.startsWith('//') && !route.includes('\\') && route.length < 240).slice(0, 3) : [];
  const prepare = Array.isArray(proposed.prepare) ? commands(proposed.prepare, 4) : commands(saved?.prepare, 4);
  return {
    summary: match ? answer.slice(0, match.index).trim() : answer,
    plan: { prepare, preview, routes: routes.length ? [...new Set(routes)] : ['/'], checks: commands(proposed.checks, 4) },
  };
}

async function commandDirectory(root: string, relativePath: string) {
  const dir = await realpath(resolve(root, relativePath));
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('The review command folder must be inside the proposal.');
  return dir;
}

const env = { CI: '1', BROWSER: 'none', FORCE_COLOR: '0' };

async function runCheck(root: string, recipe: RecipeCommand, timeout = 120_000): Promise<ProposalCheck> {
  const cwd = await commandDirectory(root, recipe.cwd);
  return new Promise((done) => {
    const child = spawn(recipe.command, { shell: true, cwd, detached: process.platform !== 'win32',
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const append = (data: Buffer) => { log = (log + data.toString()).slice(-3000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (status: ProposalCheck['status'], detail?: string) => {
      clearTimeout(timer);
      done({ command: recipe.command, status, detail });
    };
    const timer = setTimeout(() => {
      finish('failed', 'The command timed out.');
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch { /* already stopped */ }
    }, timeout);
    child.on('error', (error) => finish('failed', error.message));
    child.on('close', (code) => finish(code === 0 ? 'passed' : 'failed', code === 0 ? undefined : log.trim() || `Exit code ${code}`));
  });
}

async function capture(root: string, plan: ProposalPlan, shooter: Shooter) {
  const images = new Map<string, { bytes?: Buffer; error?: string }>();
  const preview = plan.preview;
  if (!preview || !shooter.available) return images;
  const process = new DevProcess('proposal');
  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const href = await process.start(await commandDirectory(root, preview.cwd), substitutePort(preview.command, port), { ...env, PORT: String(port), HOST: '127.0.0.1' }, origin);
    if (new URL(href).port !== String(port)) throw new Error('The preview must listen on the assigned $PORT to keep the live project separate.');
    for (const route of plan.routes) {
      const url = new URL(route, origin);
      if (url.origin !== origin) continue;
      const shot = await (async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`The preview route returned HTTP ${response.status}.`);
        return shooter.shoot({ key: route, label: route, kind: 'page', url: url.href, width: 1200, height: 800 }, {});
      })().then((bytes) => ({ bytes }), (error: Error) => ({ error: error.message }));
      images.set(route, shot);
    }
  } catch (error) {
    for (const route of plan.routes) images.set(route, { error: (error as Error).message });
  } finally {
    process.stop();
  }
  return images;
}

export async function verifyProposal(beforeRoot: string, afterRoot: string, plan: ProposalPlan, shooter: Shooter, dir: string) {
  const checks: ProposalCheck[] = [];
  let ready = true;
  for (const recipe of plan.prepare) {
    const result = await runCheck(afterRoot, recipe);
    checks.push(result);
    if (result.status === 'failed') { ready = false; break; }
  }
  for (const recipe of plan.checks) {
    checks.push(ready ? await runCheck(afterRoot, recipe) : { command: recipe.command, status: 'skipped', detail: 'Project preparation failed.' });
  }
  if (!plan.checks.length) checks.push({ command: 'Project checks', status: 'skipped', detail: 'The agent did not find a check to run.' });

  const shots: VisualShot[] = [];
  if (!plan.preview || !ready || !shooter.available) {
    return { checks, shots, note: !ready ? 'Project preparation failed. Preview skipped.'
      : !plan.preview ? 'The agent did not find a preview command.' : shooter.reason ?? 'A browser is unavailable.' };
  }
  let baselineReady = true;
  for (const recipe of plan.prepare) {
    if ((await runCheck(beforeRoot, recipe)).status === 'failed') { baselineReady = false; break; }
  }
  const before = baselineReady ? await capture(beforeRoot, plan, shooter) : new Map<string, { bytes?: Buffer; error?: string }>();
  const after = await capture(afterRoot, plan, shooter);
  await mkdir(dir, { recursive: true });
  for (const [i, route] of plan.routes.entries()) {
    const a = before.get(route), b = after.get(route);
    const shot: VisualShot = { key: route, label: route, kind: 'page' };
    if (a?.bytes) {
      const file = `route-${i}-before.png`;
      await writeFile(join(dir, file), a.bytes);
      shot.before = file;
    }
    if (b?.bytes) {
      const file = `route-${i}-after.png`;
      await writeFile(join(dir, file), b.bytes);
      shot.after = file;
    }
    if (a?.bytes && b?.bytes) {
      const diff = diffPng(a.bytes, b.bytes);
      shot.changed = diff.ratio;
      shot.sizeChanged = diff.sizeChanged;
      if (diff.changed) {
        const file = `route-${i}-diff.png`;
        await writeFile(join(dir, file), diff.png);
        shot.diff = file;
      }
    } else shot.error = [a?.error, b?.error, !baselineReady && 'Baseline preparation failed.'].filter(Boolean).join(' · ') || 'A comparison image is unavailable.';
    shots.push(shot);
  }
  return { checks, shots };
}
