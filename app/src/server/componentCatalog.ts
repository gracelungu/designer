import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { componentKey, type ComponentCatalogStatus, type ComponentEntry, type ProjectInfo } from '../shared/protocol.js';
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

async function analyze(project: ProjectInfo, claudePath: string, model: string | undefined, signal: AbortSignal) {
  const root = project.path;
  const prompt = [
    'Inventory the reusable visual components in this repository for Designer’s canvas.',
    'Inspect the entire project tree and each source package, including monorepo packages and non-JavaScript templates. Inspect component exports, entry points, global styles, providers and representative usages. Skip dependencies, generated trees, routes, pages, example stories, tests and secrets.',
    'Return one JSON object with a components array. Each entry has name, file (relative to project), exportName (default or the exact named export; empty for a template), framework (react, vue, svelte or custom), optional group (slash-separated existing source grouping), props (array of {name,optional,type}), and optional previewProps (JSON values for required inputs).',
    'Use the list below as the existing inventory. Return additions and entries that need corrections, preview inputs, global styles or special setup. Keep the same file and export for existing entries. An empty array is valid when no additions or overrides are needed.',
    'When needed add styles (project-relative global stylesheet paths), aliases (an object mapping existing bare import aliases to project-relative paths), and renderer (plain JavaScript module source that exports mount(root, props), using no JSX or TypeScript syntax). The module resolves imports from the component source folder, can import the real source and use project browser dependencies, and can supply providers, slots or mock data. It can return a cleanup function for rerenders. Avoid unrelated app bootstrap, network, and servers. For non-browser components, use a browser-compatible entry when the project provides one. Do not approximate the real component with invented markup.',
    'Do not write files, install anything, run a command, or require Storybook. Return JSON only.',
    JSON.stringify(project.components.map(({ name, file, exportName, framework }) => ({ name, file, exportName, framework }))),
  ].join('\n\n');
  let cli: ClaudeCli | undefined;
  let last = '';
  let timer: ReturnType<typeof setTimeout>;
  let cancel: () => void;
  const result = new Promise<string>((done, fail) => {
    cancel = () => fail(new Error('Component analysis cancelled.'));
    timer = setTimeout(() => fail(new Error('Component analysis took too long.')), 5 * 60_000);
    cli = new ClaudeCli({
      claudePath, cwd: root, model, tools: READ_TOOLS, settingSources: '',
      onPermission: async ({ toolName }) => READ_TOOLS.includes(toolName) ? { behavior: 'allow' } : { behavior: 'deny', message: 'Component analysis only reads source within the selected folder.' },
      hooks: { PreToolUse: [{ matcher: READ_TOOLS.join('|'), id: 'check-source-path' }] },
      onHook: async (_id, input) => {
        const tool = asObject(input.tool_input);
        const path = resolve(root, String(tool.file_path ?? tool.path ?? '.'));
        const target = await realpath(path).catch(() => path);
        if (!inside(root, path) || !inside(root, target)) return { decision: 'block', reason: 'Read within the selected folder.' };
        const rel = relative(root, target);
        if (/(^|[\\/])(?:\.env(?:\.[^/\\]*)?|\.git|node_modules)(?:[\\/]|$)/.test(rel)) return { decision: 'block', reason: 'Skip secrets, Git data and installed dependencies.' };
        return {};
      },
      onMessage: (m) => {
        if (m.type === 'assistant') {
          const blocks = asObject(m.message).content;
          if (Array.isArray(blocks)) {
            const text = blocks.map(asObject).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
            if (text.trim()) last = text;
          }
        }
        if (m.type === 'result') {
          if (m.subtype === 'success' && !m.is_error) done(String(m.result || last).trim());
          else fail(new Error('Claude could not complete the component scan.'));
        }
      },
      onExit: () => fail(new Error('Claude Code stopped during the component scan.')),
    });
  });
  signal.addEventListener('abort', cancel!, { once: true });
  if (signal.aborted) cancel!();
  try {
    await Promise.race([cli!.ready, result]);
    if (signal.aborted) throw new Error('Component analysis cancelled.');
    cli!.sendUser(prompt);
    const json = (await result).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(json) as unknown;
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel!);
    cli?.close();
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

  async scan(project: ProjectInfo, claudePath: string | undefined, model: string | undefined, publish: () => void) {
    if (this.project !== project.path) return;
    this.job?.abort();
    if (!claudePath) {
      this.status = { state: 'local' };
      publish();
      return;
    }
    const job = new AbortController();
    this.job = job;
    this.status = { state: 'scanning' };
    publish();
    try {
      const raw = await analyze(project, claudePath, model, job.signal);
      const recipes = await parseCatalog(project.path, raw);
      if (this.job !== job) return;
      this.recipes = recipes;
      this.status = { state: 'ready' };
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
      this.status = this.job === job ? { state: 'failed', detail: (e as Error).message } : this.status;
    } finally {
      if (this.job === job) {
        this.job = undefined;
        publish();
      }
    }
  }
}
