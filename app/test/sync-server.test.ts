// Design <-> code sync on the server: the Claude Code job (driven through a fake `claude` that speaks
// the real stream-json protocol, so no Claude credits are needed), Keep/Discard, the HEAD watcher,
// and the HTTP routes end to end.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeChange, LayerSync, SyncJob } from '../src/shared/protocol';
import { buildSyncPrompt, CodeSync, filesBetween, HeadWatcher, runCodeJob } from '../src/server/sync';

const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');
chmodSync(fake, 0o755);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'designer-sync-')));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = tmp();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'Button.css'), '.button {\n  background: #111111;\n  border-radius: 6px;\n}\n');
  writeFileSync(join(dir, 'src', 'Button.stories.tsx'), "export default { title: 'UI/Button' };\nexport const Primary = { args: { size: 'md' } };\n");
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 'T');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

const layer: LayerSync = {
  layerId: 'L1',
  name: 'Button',
  kind: 'design',
  storyId: 'ui-button--primary',
  file: 'src/Button.stories.tsx',
  exportName: 'Primary',
  changes: [{ prop: 'fill', label: 'Fill', from: '#111111', to: '#2563EB', css: 'background-color: #2563EB' }],
};

let env: NodeJS.ProcessEnv;
beforeEach(() => (env = { ...process.env }));
afterEach(() => {
  process.env = env;
});
/** What the fake Claude does on its turn (see fixtures/fake-claude.mjs). */
const script = (steps: unknown[], summary = 'Button.css: background is now #2563EB.') => {
  process.env.FAKE_CLAUDE_EDITS = JSON.stringify(steps);
  process.env.FAKE_CLAUDE_SUMMARY = summary;
};

describe('the prompt Claude gets', () => {
  it('names the layer, where it lives in code, and each change with its CSS', () => {
    const p = buildSyncPrompt([layer, { ...layer, layerId: 'L2', kind: 'component', name: 'Badge', changes: [{ prop: 'arg:tone', label: 'Prop tone', from: 'info', to: 'danger' }] }]);
    expect(p).toContain('The design layer "Button" is linked to a coded component (file src/Button.stories.tsx, export Primary, story ui-button--primary)');
    expect(p).toContain('- Fill: #111111 -> #2563EB  (CSS: background-color: #2563EB)');
    expect(p).toContain('The live component "Badge"');
    expect(p).toContain('- Prop tone: info -> danger');
    expect(p).toMatch(/use it instead of the raw value/);
    expect(p).toMatch(/Do not run commands/);
  });
});

describe('runCodeJob over the real CLI protocol (fake claude)', () => {
  it('returns each file with before and after, and the summary', async () => {
    const dir = repo();
    const promptOut = join(dir, '..', `prompt-${Date.now()}.json`);
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    script([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);
    const progress: string[] = [];
    const r = await runCodeJob({ claudePath: fake, cwd: dir, prompt: buildSyncPrompt([layer]), onProgress: (t) => progress.push(t) });
    expect(r.files).toEqual([{ path: 'src/Button.css', before: expect.stringContaining('#111111'), after: expect.stringContaining('#2563EB') }]);
    expect(r.summary).toBe('Button.css: background is now #2563EB.');
    expect(progress).toContain('Editing src/Button.css');
    const sent = JSON.parse(readFileSync(promptOut, 'utf8')) as { args: string[]; prompt: string };
    expect(sent.prompt).toContain('Fill: #111111 -> #2563EB');
    expect(sent.args).toContain('--append-system-prompt');
  });

  it('records new files as created (before = null)', async () => {
    const dir = repo();
    script([{ file: 'src/tokens.css', new: ':root { --brand: #2563EB; }\n' }]);
    const r = await runCodeJob({ claudePath: fake, cwd: dir, prompt: 'x' });
    expect(r.files).toEqual([{ path: 'src/tokens.css', before: null, after: ':root { --brand: #2563EB; }\n' }]);
  });

  it('refuses commands and edits outside the repository', async () => {
    const dir = repo();
    const outside = join(tmp(), 'evil.txt');
    script([
      { tool: 'Bash', input: { command: 'rm -rf src' } },
      { tool: 'Write', input: { file_path: outside, content: 'x' } },
      { file: 'src/Button.css', old: '6px', new: '12px' },
    ]);
    const r = await runCodeJob({ claudePath: fake, cwd: dir, prompt: 'x' });
    expect(existsSync(join(dir, 'src'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(['src/Button.css']);
  });

  it('fails cleanly when Claude Code is missing or exits', async () => {
    await expect(runCodeJob({ claudePath: join(tmp(), 'no-claude'), cwd: repo(), prompt: 'x' })).rejects.toThrow();
  });
});

describe('CodeSync jobs: review, Keep, Discard', () => {
  async function started(steps: unknown[]) {
    const dir = repo();
    script(steps);
    const sent: SyncJob[] = [];
    const sync = new CodeSync({ claudePath: () => fake, cwd: () => dir, send: (j) => sent.push(structuredClone(j)) });
    const job = sync.start([layer]);
    expect(job.status).toBe('running');
    await vi.waitFor(() => expect(sync.jobs.get(job.id)!.status).not.toBe('running'), { timeout: 10000 });
    return { dir, sync, job: sync.jobs.get(job.id)!, sent };
  }

  it('a finished job waits for review with the diff', async () => {
    const { job, sent } = await started([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);
    expect(job.status).toBe('review');
    expect(job.files[0].path).toBe('src/Button.css');
    expect(sent.map((j) => j.status)).toContain('running');
    expect(sent.at(-1)!.status).toBe('review');
  });

  it('Keep leaves the code changed', async () => {
    const { dir, sync, job } = await started([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);
    expect(sync.keep(job.id).status).toBe('kept');
    expect(readFileSync(join(dir, 'src/Button.css'), 'utf8')).toContain('#2563EB');
    expect(() => sync.keep(job.id)).toThrow(/already kept/);
  });

  it('Discard restores edited files and removes created ones', async () => {
    const { dir, sync, job } = await started([
      { file: 'src/Button.css', old: '#111111', new: '#2563EB' },
      { file: 'src/tokens.css', new: ':root{}\n' },
    ]);
    await sync.discard(job.id);
    expect(readFileSync(join(dir, 'src/Button.css'), 'utf8')).toContain('#111111');
    expect(existsSync(join(dir, 'src/tokens.css'))).toBe(false);
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  });

  it("Discard leaves a file alone when it changed again after Claude's edit", async () => {
    const { dir, sync, job } = await started([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);
    writeFileSync(join(dir, 'src/Button.css'), 'hand edited\n');
    const r = await sync.discard(job.id);
    expect(r.skipped).toEqual(['src/Button.css']);
    expect(readFileSync(join(dir, 'src/Button.css'), 'utf8')).toBe('hand edited\n');
  });

  it('a job that changes nothing fails with what Claude said', async () => {
    const { job } = await started([]);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/did not change any files/);
  });

  it('one job at a time, and only with changes', async () => {
    const dir = repo();
    script([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);
    const sync = new CodeSync({ claudePath: () => fake, cwd: () => dir, send: () => undefined });
    expect(() => sync.start([{ ...layer, changes: [] }])).toThrow(/no canvas changes/);
    sync.start([layer]);
    expect(() => sync.start([layer])).toThrow(/already/);
    expect(() => new CodeSync({ claudePath: () => undefined, cwd: () => dir, send: () => undefined }).start([layer])).toThrow(/not found/);
  });
});

describe('HeadWatcher: code that changed under the canvas', () => {
  it('reports a pull with the files it brought, once', async () => {
    const origin = repo();
    const mine = tmp();
    sh(mine, 'clone', '-q', origin, '.');
    const changes: CodeChange[] = [];
    const w = new HeadWatcher((c) => changes.push(c), 60_000);
    await w.watch(mine);
    expect(await w.check()).toBeNull();

    writeFileSync(join(origin, 'src', 'Button.css'), '.button { background: #2563EB; }\n');
    sh(origin, 'commit', '-qam', 'blue button');
    sh(mine, 'pull', '-q');
    const c = await w.check('pull');
    expect(c).toMatchObject({ reason: 'pull', files: ['src/Button.css'] });
    expect(await w.check()).toBeNull();
    expect(changes).toHaveLength(1);
    w.stop();
  });

  it('filesBetween is empty for the same commit or a non-repo', async () => {
    const dir = repo();
    const head = sh(dir, 'rev-parse', 'HEAD');
    expect(await filesBetween(dir, head, head)).toEqual([]);
    expect(await filesBetween(tmp(), 'a', 'b')).toEqual([]);
  });
});

describe('HTTP routes end to end', () => {
  it('to-code -> review -> keep, and Get latest reports what it pulled', async () => {
    // Put the fake on PATH as `claude`, the way Designer finds the real one.
    const bin = tmp();
    symlinkSync(fake, join(bin, 'claude'));
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    delete process.env.DESIGNER_CLAUDE_PATH;
    script([{ file: 'src/Button.css', old: '#111111', new: '#2563EB' }]);

    const origin = repo();
    sh(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
    const mine = tmp();
    sh(mine, 'clone', '-q', origin, '.');
    sh(mine, 'config', 'user.email', 't@example.com');
    sh(mine, 'config', 'user.name', 'T');

    const { startServer } = await import('../src/server/index');
    const srv = await startServer({ port: 0, workspace: tmp() });
    const call = async <T,>(path: string, body?: unknown) => {
      const r = await fetch(`${srv.url}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-designer-token': srv.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = (await r.json()) as T & { error?: string };
      if (!r.ok) throw new Error(data.error);
      return data;
    };
    try {
      await expect(call('/api/sync/to-code', { layers: [layer] })).rejects.toThrow(/Add a project/);
      await call('/api/project', { path: mine });
      const job = await call<SyncJob>('/api/sync/to-code', { layers: [layer] });
      await vi.waitFor(async () => expect((await call<SyncJob[]>('/api/sync'))[0].status).toBe('review'), { timeout: 10000 });
      const kept = await call<SyncJob>('/api/sync/keep', { id: job.id });
      expect(kept.status).toBe('kept');
      expect(readFileSync(join(mine, 'src/Button.css'), 'utf8')).toContain('#2563EB');

      // A teammate changes the code; Get latest brings it and says which files moved.
      sh(mine, 'checkout', '--', '.');
      const other = tmp();
      sh(other, 'clone', '-q', origin, '.');
      sh(other, 'config', 'user.email', 'o@example.com');
      sh(other, 'config', 'user.name', 'O');
      writeFileSync(join(other, 'src', 'Button.css'), '.button { background: #16A34A; }\n');
      sh(other, 'commit', '-qam', 'green');
      sh(other, 'push', '-q', 'origin', 'main');
      const latest = await call<{ ok: boolean; files: string[] }>('/api/git/latest', {});
      expect(latest.ok).toBe(true);
      expect(latest.files).toEqual(['src/Button.css']);
    } finally {
      srv.close();
    }
  });
});
