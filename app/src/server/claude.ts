import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeInstall, ModeOption } from '../shared/protocol.js';

const run = promisify(execFile);

/** Places the native installer, npm, Homebrew and others put `claude`. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'claude'));
  const known = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  const all = env.DESIGNER_CLAUDE_PATH ? [env.DESIGNER_CLAUDE_PATH, ...fromPath, ...known] : [...fromPath, ...known];
  return [...new Set(all)];
}

export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return candidatePaths(env).find((p) => existsSync(p));
}

/**
 * Apps started from Finder don't get the login shell's PATH or exported
 * variables (such as ANTHROPIC_API_KEY). Read them from the user's shell once.
 */
export async function loadLoginShellEnv(): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const marker = '__DESIGNER_ENV__';
    const { stdout } = await run(shell, ['-ilc', `echo ${marker}; env; echo ${marker}`], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    const block = stdout.split(marker)[1] ?? '';
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const key = line.slice(0, i);
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
      if (key === 'PATH') process.env.PATH = line.slice(i + 1);
      else if (process.env[key] === undefined) process.env[key] = line.slice(i + 1);
    }
  } catch {
    // Keep the environment we have; detection falls back to known paths.
  }
}

export async function detectClaude(): Promise<ClaudeInstall> {
  const path = findClaude();
  if (!path) return { found: false, error: 'Claude Code is not installed. Install it from https://claude.com/claude-code and sign in, then reopen Designer.' };
  const out: ClaudeInstall = { found: true, path };
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 15000 });
    out.version = stdout.trim().split(/\s+/)[0];
  } catch (e) {
    out.error = `Could not run ${path}: ${(e as Error).message}`;
    return out;
  }
  try {
    const { stdout } = await run(path, ['auth', 'status'], { timeout: 15000 });
    const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    out.loggedIn = !!status.loggedIn;
    out.authMethod = status.authMethod;
    out.apiProvider = status.apiProvider;
  } catch (e) {
    const err = e as { stdout?: string };
    try {
      const status = JSON.parse(err.stdout ?? '') as { loggedIn?: boolean };
      out.loggedIn = !!status.loggedIn;
    } catch {
      out.loggedIn = false;
    }
  }
  return out;
}

/** Friendly names for the modes Claude Code reports; any mode we don't know is shown by its own name. */
const MODE_LABELS: Record<string, { label: string; description: string }> = {
  default: { label: 'Ask before edits', description: 'Claude asks before each edit or command.' },
  manual: { label: 'Ask before edits', description: 'Claude asks before each edit or command.' },
  acceptEdits: { label: 'Auto-accept edits', description: 'File edits are applied without asking; commands still ask.' },
  plan: { label: 'Plan first', description: 'Claude reads and proposes a plan, and changes nothing until you approve.' },
  auto: { label: 'Auto', description: 'Claude decides which actions are safe to run without asking.' },
  dontAsk: { label: "Don't ask", description: 'Anything not already allowed is declined without asking.' },
  bypassPermissions: { label: 'Bypass permissions', description: 'Everything runs without asking. Use only in a throwaway copy.' },
};

/** Parse `--permission-mode` choices out of `claude --help`. */
export function parsePermissionModes(help: string): string[] {
  const at = help.indexOf('--permission-mode');
  if (at < 0) return [];
  const m = /\(choices:([^)]*)\)/.exec(help.slice(at, at + 600));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

export function modeOptions(values: string[]): ModeOption[] {
  // Show the safest modes first, as Claude Code does.
  const order = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
  return [...values]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((value) => ({ value, ...(MODE_LABELS[value] ?? { label: value, description: '' }) }));
}

/** The permission modes the installed Claude Code accepts, read from its own help text. */
export async function permissionModes(claudePath: string): Promise<ModeOption[]> {
  const { stdout } = await run(claudePath, ['--help'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return modeOptions(parsePermissionModes(stdout));
}
