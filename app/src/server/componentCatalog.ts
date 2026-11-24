import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { componentKey, type ComponentCatalogStatus, type ComponentEntry, type ComponentScanStep, type ProjectInfo } from '../shared/protocol.js';
import { ClaudeCli } from './claudeCli.js';
import { componentPath } from './project.js';

interface Recipe {
  component: ComponentEntry;
  /** Browser module providing `mount(root, props)`. Resolved from the component's folder. */
  renderer?: string;
  styles?: string[];
  aliases?: Record<string, string>;
  props?: Record<string, unknown>;
}

export function sourceGroup(file: string) {
  const folders = file.split('/').slice(0, -1);
  const componentDir = folders.findLastIndex((part) => /^(components?|widgets?)$/i.test(part));
  const parents = folders.slice(0, componentDir === -1 ? folders.length : componentDir).filter((part) => !/^(src|lib|app|packages|apps)$/i.test(part));
  return [...parents, ...folders.slice(componentDir === -1 ? folders.length : componentDir + 1)].join('/');
}

function inside(root: string, path: string) {
  const r = relative(root, path);
  return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function parseCatalog(project: string, value: unknown): Promise<Map<string, Recipe>> {
  const raw = asObject(value);
  if (!Array.isArray(raw.components)) throw new Error('Claude returned an invalid component manifest.');
  const result = new Map<string, Recipe>();
  for (const item of raw.components) {
    const row = asObject(item);
    const file = typeof row.file === 'string' ? await componentPath(project, row.file) : '';
    if (!file || typeof row.name !== 'string' || !row.name.trim() || typeof row.exportName !== 'string') continue;
    const framework = row.framework === 'react' || row.framework === 'vue' || row.framework === 'svelte' ? row.framework : 'custom';
    const props = Array.isArray(row.props) ? row.props.map(asObject).filter((prop) => typeof prop.name === 'string').map((prop) => ({
      name: String(prop.name),
      optional: prop.optional === true,
      type: typeof prop.type === 'string' ? prop.type : undefined,
      default: typeof prop.default === 'string' ? prop.default : undefined,
    })) : [];
    const component: ComponentEntry = {
      name: row.name.trim(),
      file,
      exportName: row.exportName,
      framework,
      group: typeof row.group === 'string' ? row.group.trim() : sourceGroup(file),
      props,
      storyIds: [],
    };
    const styles = await Promise.all((Array.isArray(row.styles) ? row.styles : []).filter((p): p is string => typeof p === 'string' && /\.(css|scss|sass|less)$/i.test(p)).map((p) => componentPath(project, p)));
    const aliases: Record<string, string> = {};
    for (const [name, path] of Object.entries(asObject(row.aliases))) {
      if (!name || name.includes('*') || typeof path !== 'string' || isAbsolute(path)) continue;
      const location = await realpath(resolve(project, path)).catch(() => undefined);
      if (location && inside(project, location)) Object.defineProperty(aliases, name, { value: relative(project, location), enumerable: true });
    }
    result.set(componentKey(component), {
      component,
      renderer: typeof row.renderer === 'string' && row.renderer.length <= 24_000 ? row.renderer : undefined,
      styles: styles.filter(Boolean),
      aliases,
      props: asObject(row.previewProps),
    });
  }
  return result;
}

const READ_TOOLS = ['Glob', 'Grep', 'Read'];

const CATALOG_SKILL = new URL('../../skills/project-component-discovery/SKILL.md', import.meta.url);

type ScanProgress = (step: ComponentScanStep, activity?: string) => void;

function outputText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function toolActivity(root: string, block: Record<string, unknown>) {
  const name = String(block.name);
  if (!READ_TOOLS.includes(name)) return undefined;
  const input = asObject(block.input);
  const target = resolve(root, String(input.file_path ?? input.path ?? '.'));
  if (!inside(root, target)) return undefined;
  const path = relative(root, target).split(sep).join('/');
  if (name === 'Read') return `Reading ${path || 'project files'}`;
  return `${name === 'Glob' ? 'Finding files' : 'Searching source'} in ${path || 'the project'}`;
}

async function analyze(project: ProjectInfo, claudePath: string, model: string | undefined, signal: AbortSignal, progress: ScanProgress) {
  const skill = await readFile(CATALOG_SKILL, 'utf8');
  signal.throwIfAborted();
  const root = project.path;
  let step: ComponentScanStep = 'connect';
  let last = '';
  let pending: { done(text: string): void; fail(error: Error): void } | undefined;
  const seen = new Set<string>();
  const cli = new ClaudeCli({
    claudePath, cwd: root, model, tools: READ_TOOLS, settingSources: '',
    appendSystemPrompt: skill,
    onPermission: async ({ toolName }) => READ_TOOLS.includes(toolName) ? { behavior: 'allow' } : { behavior: 'deny', message: 'Component analysis only reads source within the selected folder.' },
    hooks: { PreToolUse: [{ matcher: READ_TOOLS.join('|'), id: 'check-source-path' }] },
    onHook: async (_id, input) => {
      const tool = asObject(input.tool_input);
      const path = resolve(root, String(tool.file_path ?? tool.path ?? '.'));
      const target = await realpath(path).catch(() => path);
      if (!inside(root, path) || !inside(root, target)) return { decision: 'block', reason: 'Read within the selected folder.' };
      if (/(^|[\\/])(?:\.env(?:\.[^/\\]*)?|\.git|node_modules)(?:[\\/]|$)/.test(relative(root, target))) return { decision: 'block', reason: 'Skip secrets, Git data and installed dependencies.' };
      return {};
    },
    onMessage: (m) => {
      if (!pending) return;
      if (m.type === 'assistant') {
        const blocks = asObject(m.message).content;
        if (!Array.isArray(blocks)) return;
        const text: string[] = [];
        for (const raw of blocks) {
          const block = asObject(raw);
          if (block.type === 'text') text.push(outputText(block.text));
          if (block.type !== 'tool_use' || typeof block.id !== 'string' || seen.has(block.id)) continue;
          seen.add(block.id);
          const activity = toolActivity(root, block);
          if (activity) progress(step, activity);
        }
        if (text.join('').trim()) last = text.join('').trim();
      } else if (m.type === 'result') {
        const result = pending;
        pending = undefined;
        const text = outputText(m.result) || last;
        if (m.subtype === 'success' && !m.is_error) result.done(text);
        else {
          const errors = Array.isArray(m.errors) ? m.errors.map(outputText).filter(Boolean).join(' ') : '';
          result.fail(new Error((errors || text || 'Claude could not complete this step.').slice(0, 500)));
        }
      }
    },
    onExit: (code, stderr) => {
      const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 500);
      pending?.fail(new Error(detail || `Claude Code stopped during the scan${code === null ? '' : ` (exit ${code})`}.`));
    },
  });
  const cancel = () => {
    pending?.fail(new Error('Component analysis cancelled.'));
    cli.close();
  };
  signal.addEventListener('abort', cancel, { once: true });
  function turn(next: ComponentScanStep, prompt: string) {
    signal.throwIfAborted();
    if (cli.closed) throw new Error('Claude Code stopped before the next scan step.');
    step = next;
    last = '';
    progress(step);
    return new Promise<string>((done, fail) => {
      pending = { done, fail };
      cli.sendUser(prompt);
    });
  }
  const timer = setTimeout(() => {
    pending?.fail(new Error('Claude Code did not finish this step in five minutes.'));
    cli.close();
  }, 5 * 60_000);
  try {
    await cli.ready;
    await turn('inspect', 'Start the inspection step for the selected project. Read its source and return a short inventory with any preview requirements. Leave the JSON manifest for the next step.');
    const inventory = project.components.map(({ name, file, exportName, framework }) => ({ name, file, exportName, framework }));
    const response = await turn('catalog', `Build the component catalog from your inspection using the skill. Return the JSON manifest. Designer already found these components:\n${JSON.stringify(inventory)}`);
    const json = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(json) as unknown;
    } catch (e) {
      throw new Error('Claude returned an incomplete or invalid component manifest.', { cause: e });
    }
  } finally {
    pending = undefined;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    cli.close();
  }
}

export class ComponentCatalog {
  private status: ComponentCatalogStatus = { state: 'local' };
  private recipes = new Map<string, Recipe>();
  private job?: AbortController;
  private project?: string;

  constructor(private readonly workspace: string) {}

  private cache(project: string) {
    return join(this.workspace, 'component-catalogs', createHash('sha256').update(project).digest('hex') + '.json');
  }

  close() {
    this.job?.abort();
    this.job = undefined;
    this.project = undefined;
    this.recipes = new Map();
    this.status = { state: 'local' };
  }

  async open(project: string) {
    this.close();
    this.project = project;
    const cached = await readFile(this.cache(project), 'utf8').then(JSON.parse).then((raw) => parseCatalog(project, raw)).catch(() => undefined);
    if (this.project === project && cached) this.recipes = cached;
  }

  merge(project: ProjectInfo): ProjectInfo {
    const components = new Map<string, ComponentEntry>(project.components.map((c) => [componentKey(c), { ...c, group: c.group ?? sourceGroup(c.file) }]));
    if (this.project === project.path) for (const [key, { component }] of this.recipes) {
      const known = components.get(key);
      components.set(key, known ? { ...known, ...component, framework: component.framework === 'custom' ? known.framework : component.framework, props: component.props.length ? component.props : known.props, storyIds: known.storyIds } : component);
    }
    return {
      ...project,
      components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)),
      catalog: this.project === project.path ? this.status : undefined,
    };
  }

  recipe(key: string) { return this.recipes.get(key); }

  async scan(project: ProjectInfo, claudePath: string | undefined, model: string | undefined, publish: (status: ComponentCatalogStatus) => void) {
    if (this.project !== project.path) return;
    this.job?.abort();
    if (!claudePath) {
      this.job = undefined;
      this.status = { state: 'local', detail: 'Connect Claude Code to inspect the project and prepare more previews.' };
      publish(this.status);
      return;
    }
    const job = new AbortController();
    this.job = job;
    const progress: ScanProgress = (step, activity) => {
      if (this.job !== job) return;
      if (this.status.state === 'scanning' && this.status.step === step && this.status.activity === activity) return;
      this.status = { state: 'scanning', step, activity };
      publish(this.status);
    };
    progress('connect');
    try {
      const raw = await analyze(project, claudePath, model, job.signal, progress);
      progress('validate');
      const recipes = await parseCatalog(project.path, raw);
      if (this.job !== job) return;
      this.recipes = recipes;
      this.status = { state: 'ready', step: 'validate' };
      const path = this.cache(project.path);
      const temp = path + '.' + randomUUID();
      try {
        await mkdir(join(this.workspace, 'component-catalogs'), { recursive: true });
        await writeFile(temp, JSON.stringify(raw), { mode: 0o600 });
        if (this.job === job) await rename(temp, path);
      } catch {
        // The live catalog is usable even when the cache directory is read-only.
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
    } catch (e) {
      this.status = this.job === job ? { state: 'failed', step: this.status.step, detail: (e as Error).message } : this.status;
    } finally {
      if (this.job === job) {
        this.job = undefined;
        publish(this.status);
      }
    }
  }
}
