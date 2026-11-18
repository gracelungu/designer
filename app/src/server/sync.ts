// Design -> code: turns canvas edits on linked layers into a code change made by the local Claude Code,
// held as a reviewable proposal (Keep or Discard). Code -> design: watches the project's HEAD so a pull,
// a commit or a branch switch tells the canvas which files changed under it.
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ClaudeCli, type CliMessage, type CliOptions } from './claudeCli.js';
import { git } from './project.js';
import type { CodeChange, LayerSync, SyncFile, SyncJob } from '../shared/protocol.js';

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];
/** Tools a sync job may use: reading the repo and editing files in it. Commands are refused. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'];

const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));

/** What Claude is asked to do for a set of canvas edits. */
export function buildSyncPrompt(layers: LayerSync[]): string {
  const parts = layers.map((l, i) => {
    const where = [l.file && `file ${l.file}`, l.exportName && `export ${l.exportName}`, l.storyId && `story ${l.storyId}`].filter(Boolean).join(', ');
    const lines = l.changes.map((c) => `   - ${c.label}: ${fmt(c.from)} -> ${fmt(c.to)}${c.css ? `  (CSS: ${c.css})` : ''}`);
    const what =
      l.kind === 'component'
        ? `The live component "${l.name}" (${where}) had its props changed on the canvas. Make the story render with these props by default (update its args):`
        : `The design layer "${l.name}" is linked to a coded component (${where}). The designer changed it on the canvas. Change the component's code so it renders the same way:`;
    return `${i + 1}. ${what}\n${lines.join('\n')}`;
  });
  return [
    'Designer sync: apply these canvas edits to the code.',
    '',
    ...parts,
    '',
    'Rules:',
    '- Change only what is listed. Keep every other style, prop and behaviour as it is.',
    "- Follow this repo's conventions. Where a design token, CSS variable or theme value matches a new value, use it instead of the raw value.",
    '- Find the component through the story file when the component file is not named.',
    '- Edit files only. Do not run commands, install packages, commit, or touch the Designer canvas.',
    '- Finish with one short sentence per file you changed, saying what changed.',
  ].join('\n');
}

export const SYNC_SYSTEM_PROMPT =
  'You are running inside Designer, a design tool on top of this repository. A designer edited linked layers on the canvas, and you turn those edits into the smallest correct code change. The designer reviews your diff and keeps or discards it, so never run commands and never edit files outside the repository.';

function inside(cwd: string, p: string) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('.git');
}

export interface RunOptions {
  claudePath: string;
  cwd: string;
  prompt: string;
  model?: string;
  onProgress?: (text: string) => void;
  timeoutMs?: number;
  /** For tests: build the CLI another way. */
  makeCli?: (o: CliOptions) => Pick<ClaudeCli, 'ready' | 'sendUser' | 'close'>;
}

/**
 * Runs one headless Claude Code turn that may read the repo and edit files in it, nothing else.
 * Returns each file it touched, with its content before the first edit and after the last.
 */
export async function runCodeJob(o: RunOptions): Promise<{ files: SyncFile[]; summary: string }> {
  const before = new Map<string, string | null>();
  let summary = '';
  let lastText = '';
  let cli!: Pick<ClaudeCli, 'ready' | 'sendUser' | 'close'>;
  const result = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => (cli?.close(), fail(new Error('Claude Code took too long. Try again with fewer changes.'))), o.timeoutMs ?? 10 * 60_000);
    const opts: CliOptions = {
      claudePath: o.claudePath,
      cwd: o.cwd,
      model: o.model,
      appendSystemPrompt: SYNC_SYSTEM_PROMPT,
      hooks: {
        PreToolUse: [{ matcher: EDIT_TOOLS.join('|'), id: 'before-edit' }],
        PostToolUse: [{ matcher: EDIT_TOOLS.join('|'), id: 'after-edit' }],
      },
      onMessage: (m: CliMessage) => {
        if (m.type === 'assistant') {
          const content = ((m.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
          for (const b of content) {
            if (b.type === 'text' && b.text?.trim()) lastText = b.text.trim();
            if (b.type === 'tool_use' && b.name) {
              const f = (b.input?.file_path ?? b.input?.path ?? b.input?.pattern) as string | undefined;
              o.onProgress?.(`${EDIT_TOOLS.includes(b.name) ? 'Editing' : b.name === 'Read' ? 'Reading' : b.name} ${f ? (isAbsolute(f) ? relative(o.cwd, f) : f) : ''}`.trim());
            }
          }
        }
        if (m.type === 'result') {
          clearTimeout(timer);
          summary = typeof m.result === 'string' && m.result.trim() ? m.result.trim() : lastText;
          if (m.subtype === 'success' && !m.is_error) done();
          else fail(new Error(summary || String(m.subtype ?? 'Claude Code could not finish')));
        }
      },
      onPermission: async ({ toolName, input }) => {
        const p = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
        if (EDIT_TOOLS.includes(toolName)) {
          if (p && inside(o.cwd, p)) return { behavior: 'allow' };
          return { behavior: 'deny', message: 'Designer sync only edits files inside the repository.' };
        }
        if (READ_TOOLS.includes(toolName)) return { behavior: 'allow' };
        return { behavior: 'deny', message: `Designer sync does not allow ${toolName}. Only read and edit files in the repository.` };
      },
      onHook: async (id, input) => {
        const ti = (input.tool_input ?? {}) as Record<string, unknown>;
        const p = ti.file_path as string | undefined;
        if (id === 'before-edit' && p && inside(o.cwd, p)) {
          const rel = relative(o.cwd, resolve(o.cwd, p));
          if (!before.has(rel)) before.set(rel, await readFile(resolve(o.cwd, rel), 'utf8').catch(() => null));
        }
        return {};
      },
      onExit: (code, stderr) => {
        clearTimeout(timer);
        fail(new Error(`Claude Code stopped${code !== null ? ` (exit ${code})` : ''}. ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim()));
      },
    };
    cli = o.makeCli ? o.makeCli(opts) : new ClaudeCli(opts);
  });
  // A failed start rejects `ready` first; don't leave this one unhandled.
  result.catch(() => undefined);
  try {
    await cli.ready;
    cli.sendUser(o.prompt);
    await result;
  } finally {
    cli.close();
  }
  const files: SyncFile[] = [];
  for (const [path, was] of before) {
    const now = await readFile(resolve(o.cwd, path), 'utf8').catch(() => null);
    if (now === null || now === was) continue;
    files.push({ path, before: was, after: now });
  }
  return { files, summary };
}

/** Design-to-code jobs for the open project, kept until the designer keeps or discards them. */
export class CodeSync {
  jobs = new Map<string, SyncJob>();
  private busy = false;

  constructor(
    private readonly o: {
      claudePath: () => string | undefined;
      cwd: () => string;
      send: (job: SyncJob) => void;
      model?: () => string | undefined;
      run?: typeof runCodeJob;
    },
  ) {}

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Starts a job and returns at once; progress and the proposal arrive through send(). */
  start(layers: LayerSync[]): SyncJob {
    const claudePath = this.o.claudePath();
    if (!claudePath) throw new Error('Claude Code was not found on this computer.');
    const real = layers.filter((l) => l.changes.length);
    if (!real.length) throw new Error('There are no canvas changes to send to code.');
    if (this.busy) throw new Error('Claude is already turning canvas changes into code. Wait for it to finish.');
    const cwd = this.o.cwd();
    const job: SyncJob = { id: randomUUID(), layers: real, status: 'running', progress: [], files: [], summary: '', createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.busy = true;
    this.o.send(job);
    const run = this.o.run ?? runCodeJob;
    void run({
      claudePath,
      cwd,
      prompt: buildSyncPrompt(real),
      model: this.o.model?.(),
      onProgress: (t) => {
        job.progress = [...job.progress, t].slice(-20);
        this.o.send(job);
      },
    }).then(
      (r) => {
        job.files = r.files;
        job.summary = r.summary;
        if (r.files.length) job.status = 'review';
        else {
          job.status = 'failed';
          job.error = r.summary ? `Claude did not change any files: ${r.summary}` : 'Claude did not change any files.';
        }
      },
      (e: Error) => {
        job.status = 'failed';
        job.error = e.message;
      },
    ).finally(() => {
      this.busy = false;
      this.o.send(job);
    });
    return job;
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('That change is no longer here.');
    if (job.status !== 'review') throw new Error(`That change was already ${job.status === 'kept' ? 'kept' : job.status === 'discarded' ? 'discarded' : 'handled'}.`);
    return job;
  }

  /** The code stays as Claude left it. */
  keep(id: string) {
    const job = this.get(id);
    job.status = 'kept';
    this.o.send(job);
    return job;
  }

  /** Puts each file back as it was, unless it changed again since Claude's edit (then it is left alone). */
  async discard(id: string) {
    const job = this.get(id);
    const cwd = this.o.cwd();
    const skipped: string[] = [];
    for (const f of job.files) {
      const abs = resolve(cwd, f.path);
      const now = await readFile(abs, 'utf8').catch(() => null);
      if (now !== f.after) {
        skipped.push(f.path);
        continue;
      }
      if (f.before === null) await unlink(abs).catch(() => undefined);
      else await writeFile(abs, f.before);
    }
    job.status = 'discarded';
    if (skipped.length) job.skipped = skipped;
    this.o.send(job);
    return job;
  }
}

// ----- Code -> design -----

export async function headOf(cwd: string) {
  return (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim();
}

export async function filesBetween(cwd: string, from: string, to: string) {
  if (!from || !to || from === to) return [];
  const out = await git(cwd, ['diff', '--name-only', from, to]).catch(() => '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Notices when the project's HEAD moves (a pull here or in a terminal, a commit, a branch switch)
 * and reports the files that changed, so the canvas can bring linked layers up to date.
 */
export class HeadWatcher {
  private cwd?: string;
  private head = '';
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<CodeChange | null>;

  constructor(
    private readonly onChange: (c: CodeChange) => void,
    private readonly intervalMs = 3000,
  ) {}

  async watch(cwd: string | undefined) {
    this.stop();
    this.cwd = cwd;
    if (!cwd) return;
    this.head = await headOf(cwd);
    this.timer = setInterval(() => void this.check('head'), this.intervalMs);
    this.timer.unref?.();
  }

  /** Looks now (after Get latest, say) instead of waiting for the next tick. */
  check(reason: CodeChange['reason'] = 'head'): Promise<CodeChange | null> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const cwd = this.cwd;
      if (!cwd) return null;
      const now = await headOf(cwd);
      if (!now || now === this.head || cwd !== this.cwd) return null;
      const from = this.head;
      this.head = now;
      const change: CodeChange = { from, to: now, files: await filesBetween(cwd, from, now), reason };
      this.onChange(change);
      return change;
    })().finally(() => (this.checking = undefined));
    return this.checking;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
