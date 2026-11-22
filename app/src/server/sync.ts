// Design -> code: turns canvas edits on linked layers into a code change made by the local Claude Code,
// held as a reviewable proposal (Keep or Discard). Code -> design: watches the project's HEAD so a pull,
// a commit or a branch switch tells the canvas which files changed under it.
import { randomUUID } from 'node:crypto';
import { cp, link, lstat, mkdir, mkdtemp, readFile, rename, rm, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCli, type CliMessage, type CliOptions } from './claudeCli.js';
import { git } from './project.js';
import { contentHash, planProposal, verifyProposal } from './proposalReview.js';
import { excludeReviews, reviewsDir, type Shooter } from './visual.js';
import type { CodeChange, LayerSync, ProposalScope, SyncFile, SyncJob, VisualReview } from '../shared/protocol.js';

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];
/** Tools a sync job may use: reading the repo and editing files in it. Commands are refused. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'];

const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));

export function scopeFor(layer: LayerSync): ProposalScope {
  return layer.scope ?? (layer.kind === 'component' ? 'example' : 'component');
}

/** What Claude is asked to do for a set of canvas edits. */
export function buildSyncPrompt(layers: LayerSync[]): string {
  const parts = layers.map((l, i) => {
    const where = [l.file && `file ${l.file}`, l.exportName && `export ${l.exportName}`, l.storyId && `story ${l.storyId}`].filter(Boolean).join(', ');
    const lines = l.changes.map((c) => `   - ${c.label}: ${fmt(c.from)} -> ${fmt(c.to)}${c.css ? `  (CSS: ${c.css})` : ''}`);
    const subject = l.kind === 'component' ? `The live component "${l.name}" (${where})`
      : `The design layer "${l.name}" is linked to a coded component (${where})`;
    const scope = scopeFor(l);
    const instruction = scope === 'example'
      ? 'Update only this example or instance in its existing route, demo, fixture or story. Keep production defaults and shared tokens unchanged.'
      : scope === 'token'
        ? `Change only the shared token "${l.token}" at its source, retaining aliases and modes. Preserve unrelated token values and component behavior.`
        : 'Update the production component default or styling for this edit. Keep existing explicit overrides working. A change to a demo or story alone does not meet the request.';
    return `${i + 1}. ${subject}. ${instruction}
${lines.join('\n')}`;
  });
  return [
    'Designer sync: apply these canvas edits to the code.',
    '',
    ...parts,
    '',
    'Rules:',
    '- Change only what is listed. Keep every other style, prop and behaviour as it is.',
    "- Follow this repo's conventions. Where a design token, CSS variable or theme value matches a new value, use it instead of the raw value.",
    '- Locate the production source through the repository’s exports, routes, examples or fixture when it is not named. Use the existing stack and conventions.',
    '- Edit files only. Do not run commands, install packages, commit, or touch the Designer canvas.',
    '- Finish with one short sentence per file, followed by an optional fenced designer-review JSON block with keys prepare, preview, routes and checks.',
    '- Discover verification from the repository’s documentation, scripts or build configuration. Use the project’s own tools. Any browser preview must listen on $PORT, and routes must be relative to that preview.',
    '- prepare and checks are arrays of {command,cwd}. preview is one {command,cwd}. routes are strings such as "/settings" for useful states already available locally. cwd is relative to the repository. Omit steps you cannot identify. If the project has no browser UI, propose its own relevant verification commands instead.',
    '- Verification commands are suggestions for the designer to run in a separate checkout after reviewing them. Never invent passing results or add tooling solely for this plan.',
  ].join('\n');
}

export const SYNC_SYSTEM_PROMPT =
  'You are running inside Designer, a design tool on top of this repository. A designer edited linked layers on the canvas, and you turn those edits into the smallest correct code change. The designer reviews your diff and keeps or discards it, so never run commands and never edit files outside the repository.';

function inside(cwd: string, p: string) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) && !rel.split(sep).includes('.git');
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

const EXCLUDED = new Set(['.git', 'node_modules', '.designer', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor', 'target']);

function proposalSource(path: string) {
  return path.split(sep).every((part) => !EXCLUDED.has(part) && (!part.startsWith('.env') || part === '.env.example'));
}

async function sourceSnapshot(cwd: string, snapshot: string) {
  const files = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => undefined);
  if (files === undefined) {
    await cp(cwd, snapshot, {
      recursive: true,
      filter: async (path) => proposalSource(relative(cwd, path)) && !(await lstat(path)).isSymbolicLink(),
    });
    return;
  }
  for (const file of new Set(files.split('\0').filter(Boolean))) {
    if (!proposalSource(file)) continue;
    const source = await proposalTarget(cwd, file).catch(() => undefined);
    if (!source) continue;
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile()) continue;
    const target = resolve(snapshot, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
}

/** Resolve a proposal target without following symlinks in the live checkout. */
async function proposalTarget(cwd: string, file: string) {
  if (!inside(cwd, file) || !proposalSource(file)) throw new Error(`The proposal cannot modify ${file}.`);
  const target = resolve(cwd, file);
  const parts = relative(cwd, target).split(sep);
  let parent = cwd;
  for (const part of parts) {
    parent = join(parent, part);
    const info = await lstat(parent).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (info?.isSymbolicLink()) throw new Error(`The proposal cannot follow a symlink at ${relative(cwd, parent)}.`);
  }
  return target;
}

async function writeProposalFile(target: string, content: string, existing: boolean) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const mode = existing ? (await lstat(target)).mode : undefined;
    await writeFile(temp, content, { mode, flag: 'wx' });
    if (existing) await rename(temp, target);
    else await link(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function checkoutRef(cwd: string) {
  return git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => headOf(cwd));
}

/** Design-to-code proposals are scoped to a project and applied after review. */
export class CodeSync {
  jobs = new Map<string, SyncJob>();
  private refs = new Map<string, string>();
  private applying = new Set<string>();

  constructor(
    private readonly o: {
      claudePath: () => string | undefined;
      cwd: () => string;
      send: (job: SyncJob) => void;
      model?: () => string | undefined;
      run?: typeof runCodeJob;
      shooter?: Shooter;
      review?: (review: VisualReview) => void;
    },
  ) {}

  list(project?: string) {
    return [...this.jobs.values()].filter((job) => job.project === project).sort((a, b) => b.createdAt - a.createdAt);
  }

  start(layers: LayerSync[], targetSvg?: string): SyncJob {
    const claudePath = this.o.claudePath();
    if (!claudePath) throw new Error('Claude Code was not found or is signed out.');
    const real = layers.filter((layer) => layer.changes.length).map((layer) => {
      const scope = scopeFor(layer);
      if (!['example', 'component', 'token'].includes(scope)) throw new Error('Choose a proposal scope.');
      const token = scope === 'token' && typeof layer.token === 'string' ? layer.token.trim() : undefined;
      if (scope === 'token' && (!token || token.length > 120)) throw new Error('Name the token to change.');
      return { ...layer, scope, token };
    });
    if (!real.length) throw new Error('There are no canvas changes to send to code.');
    const cwd = this.o.cwd();
    if (this.list(cwd).some((job) => job.status === 'running')) throw new Error('Claude is already preparing a code proposal for this project.');
    const job: SyncJob = { id: randomUUID(), project: cwd, layers: real, status: 'running', progress: [], files: [], summary: '', targetSvg: targetSvg?.length && targetSvg.length <= 250_000 ? targetSvg : undefined, createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.o.send(job);
    void this.prepare(cwd, claudePath, job);
    return job;
  }

  private async prepare(cwd: string, claudePath: string, job: SyncJob) {
    let snapshot: string | undefined;
    try {
      this.refs.set(job.id, await checkoutRef(cwd));
      snapshot = await mkdtemp(join(tmpdir(), 'designer-proposal-'));
      await sourceSnapshot(cwd, snapshot);
      const run = this.o.run ?? runCodeJob;
      const result = await run({
        claudePath, cwd: snapshot, prompt: buildSyncPrompt(job.layers), model: this.o.model?.(),
        onProgress: (text) => {
          job.progress = [...job.progress, text].slice(-20);
          this.o.send(job);
        },
      });
      if (!result.files.length) throw new Error(result.summary ? `Claude did not change any files: ${result.summary}` : 'Claude did not change any files.');
      job.files = result.files;
      const { summary, plan } = await planProposal(cwd, result.summary);
      job.summary = summary;
      job.plan = plan;
      const targets = [...new Set(job.layers.map((l) => l.token || l.exportName || l.name))].slice(0, 5);
      const references = await git(cwd, ['grep', '-l', '-z', '-F', ...targets.flatMap((name) => ['-e', name]), '--', '.', ':(exclude).designer/**']).catch(() => '');
      job.references = references.split('\0').filter((path) => path && !result.files.some((f) => f.path === path)).slice(0, 12);
      job.status = 'review';
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
    } finally {
      if (snapshot) await rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
      this.o.send(job);
    }
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.project !== this.o.cwd()) throw new Error('That proposal is not in this project.');
    if (this.applying.has(job.project!)) throw new Error('A code proposal is already being applied.');
    if (job.verifying) throw new Error('Wait for the proposal checks to finish.');
    if (job.status !== 'review') throw new Error(`That change was already ${job.status === 'kept' ? 'kept' : job.status === 'discarded' ? 'discarded' : 'handled'}.`);
    return job;
  }

  private reviewRecord(job: SyncJob, base: string): VisualReview {
    return {
      id: job.id, title: `Design proposal: ${job.layers.map((l) => l.name).join(', ')}`, createdAt: Date.now(),
      files: job.files.map((file) => file.path), shots: [], note: 'Preview and checks have not been run.',
      proposal: {
        base,
        intent: job.layers.map((l) => ({ name: l.name, scope: scopeFor(l), token: l.token, changes: l.changes })),
        hashes: Object.fromEntries(job.files.map((f) => [f.path, contentHash(f.after)])),
        checks: [],
      },
    };
  }

  async verify(id: string) {
    const job = this.get(id);
    if (!job.plan || !this.o.shooter) throw new Error('Preview and checks are unavailable.');
    const project = job.project!;
    job.verifying = true;
    const review = this.reviewRecord(job, await headOf(project));
    this.o.send(job);
    let temp: string | undefined;
    try {
      if (await checkoutRef(project) !== this.refs.get(id)) throw new Error('Open the branch where this proposal was created.');
      temp = await mkdtemp(join(tmpdir(), 'designer-verify-'));
      const before = join(temp, 'before'), after = join(temp, 'after');
      await mkdir(before, { recursive: true });
      await sourceSnapshot(project, before);
      await cp(before, after, { recursive: true });
      for (const file of job.files) {
        const path = await proposalTarget(after, file.path);
        const value = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (value !== file.before) throw new Error(`${file.path} changed. Create a fresh proposal before verifying it.`);
        await mkdir(dirname(path), { recursive: true });
        await writeProposalFile(path, file.after, value !== null);
      }
      await excludeReviews(project);
      const dir = join(reviewsDir(project), id);
      const evidence = await verifyProposal(await realpath(before), await realpath(after), job.plan, this.o.shooter, dir);
      for (const file of job.files) {
        const path = await proposalTarget(after, file.path);
        if (await readFile(path, 'utf8') !== file.after) {
          throw new Error(`The verification commands changed ${file.path}. The captured results do not represent this proposal.`);
        }
      }
      review.shots = evidence.shots;
      review.note = evidence.note;
      review.proposal!.checks = evidence.checks;
    } catch (error) {
      review.note = (error as Error).message;
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      job.verifying = false;
      job.evidence = review;
      this.o.send(job);
    }
    return job;
  }

  async keep(id: string) {
    const job = this.get(id);
    const cwd = job.project!;
    this.applying.add(cwd);
    const applied: { file: SyncFile; target: string }[] = [];
    const read = (path: string) => readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    try {
      if (await checkoutRef(cwd) !== this.refs.get(id)) throw new Error('The checkout changed branches. Open the original branch or create a fresh proposal.');
      const targets = await Promise.all(job.files.map(async (file) => ({ file, target: await proposalTarget(cwd, file.path) })));
      for (const { file, target } of targets) {
        if (await read(target) !== file.before) throw new Error(`${file.path} changed after this proposal was prepared. Create a fresh proposal.`);
      }
      for (const item of targets) {
        const { file, target } = item;
        await mkdir(dirname(target), { recursive: true });
        if (await read(target) !== file.before) throw new Error(`${file.path} changed while applying this proposal.`);
        await writeProposalFile(target, file.after, file.before !== null);
        applied.push(item);
      }
      const review = job.evidence ?? this.reviewRecord(job, await headOf(cwd));
      await excludeReviews(cwd);
      const dir = join(reviewsDir(cwd), id);
      await mkdir(dir, { recursive: true });
      await writeProposalFile(join(dir, 'review.json'), JSON.stringify(review, null, 2), false);
      job.status = 'kept';
      this.o.review?.(review);
      this.o.send(job);
      return job;
    } catch (e) {
      for (const { file, target } of applied.reverse()) {
        if (await read(target) !== file.after) continue;
        if (file.before === null) await unlink(target);
        else await writeProposalFile(target, file.before, true);
      }
      throw e;
    } finally {
      this.applying.delete(cwd);
    }
  }

  async discard(id: string) {
    const job = this.get(id);
    job.status = 'discarded';
    await rm(join(reviewsDir(job.project!), id), { recursive: true, force: true }).catch(() => undefined);
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
    const head = await headOf(cwd);
    if (this.cwd !== cwd) return;
    this.head = head;
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
      if (this.cwd !== cwd) return null;
      this.onChange(change);
      return change;
    })().finally(() => (this.checking = undefined));
    return this.checking;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cwd = undefined;
  }
}
