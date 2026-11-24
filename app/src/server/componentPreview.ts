import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { PluginOption } from 'vite';
import { componentKey, type ComponentEntry } from '../shared/protocol.js';
import { componentPath } from './project.js';
import { detectPackageManager, readPackageJson } from './setup.js';

type PreviewRecipe = { renderer?: string; styles?: string[]; props?: Record<string, unknown>; aliases?: Record<string, string> };
type Bundle = { page: string; files: Map<string, string | Uint8Array> };
const exists = (p: string) => access(p).then(() => true, () => false);
const run = promisify(execFile);
const FRAMEWORKS = { react: ['react', 'react-dom'], vue: ['vue', '@vitejs/plugin-vue'], svelte: ['svelte', '@sveltejs/vite-plugin-svelte'], custom: [] };

async function packageFolder(project: string, file: string) {
  let dir = dirname(join(project, file));
  while (dir !== project && !await exists(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

function resolveModule(from: NodeRequire, name: string) {
  try {
    return from.resolve(name);
  } catch {
    // Older runtimes cannot resolve an import-only package through createRequire.
    if (name.split('/').length > (name.startsWith('@') ? 2 : 1)) return undefined;
    for (const dir of from.resolve.paths(name) ?? []) {
      const root = join(dir, name);
      try {
        const pkg = from(join(root, 'package.json'));
        const exports = pkg.exports?.['.'] ?? pkg.exports;
        const entry = typeof exports === 'string' ? exports : exports?.import ?? exports?.node?.import ?? exports?.default ?? pkg.module ?? pkg.main;
        if (typeof entry === 'string') return resolve(root, entry);
      } catch {
        // This search location does not contain the package.
      }
    }
  }
}

async function installDependencies(root: string, dir: string, signal: AbortSignal) {
  const { pm, root: installDir } = await detectPackageManager(dir, root);
  const npmLock = await exists(join(installDir, 'package-lock.json')) || await exists(join(installDir, 'npm-shrinkwrap.json'));
  const config = await readPackageJson(installDir);
  const isModernYarn = /^yarn@[2-9]/.test(config?.packageManager ?? '') || await exists(join(installDir, '.yarnrc.yml'));
  const args = {
    npm: npmLock ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'],
    pnpm: ['install', '--ignore-scripts', '--frozen-lockfile'],
    yarn: isModernYarn ? ['install', '--immutable'] : ['install', '--ignore-scripts', '--pure-lockfile'],
    bun: ['install', '--ignore-scripts', '--frozen-lockfile'],
  }[pm];
  try {
    await run(pm, args, { cwd: installDir, signal, timeout: 180_000, env: { ...process.env, ...(isModernYarn && { YARN_ENABLE_SCRIPTS: 'false' }) } });
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const detail = (err.stderr || err.message).trim().split('\n').slice(-5).join('\n');
    throw new Error(`Could not install preview dependencies in ${relative(root, installDir) || 'the project folder'}.\n${detail}`, { cause: e });
  }
}

async function projectStyles(root: string, file: string) {
  // Read style imports from the project's entry points without importing the app itself.
  const entries = ['', 'src/', 'app/', 'src/app/'].flatMap((prefix) =>
    ['main', 'index', 'App', 'layout', 'app'].flatMap((entry) => ['tsx', 'jsx', 'ts', 'js', 'vue', 'svelte'].map((ext) => prefix + entry + '.' + ext)));
  const styles = new Set<string>();
  for (const entry of entries) {
    const path = join(root, entry);
    const code = await readFile(path, 'utf8').catch(() => '');
    for (const match of code.matchAll(/\bimport\s*['"](\.[^'"]+\.(?:css|scss|sass|less))['"]/g)) styles.add(resolve(dirname(path), match[1]));
  }
  styles.delete(file);
  return [...styles];
}

function previewProps(component: ComponentEntry, overrides: PreviewRecipe['props']) {
  const argTypes: Record<string, { name: string; type?: string; options?: unknown[] }> = {};
  const defaults: Record<string, unknown> = {};
  const callbacks: string[] = [];
  for (const prop of component.props) {
    const { name, type } = prop;
    if (/^on[A-Z]/.test(name) || type?.includes('=>')) {
      if (!prop.optional) callbacks.push(name);
      continue;
    }
    const parts = type?.split('|').map((part) => part.trim());
    const options = parts?.every((part) => /^(['"]).*\1$/.test(part)) ? parts.map((part) => part.slice(1, -1)) : undefined;
    const primitive = /^(?:string|String|ReactNode)$/.test(type ?? '') ? 'string'
      : /^(?:number|Number)$/.test(type ?? '') ? 'number'
      : /^(?:boolean|Boolean)$/.test(type ?? '') ? 'boolean' : undefined;
    argTypes[name] = { name, type: primitive, options };
    if (prop.default !== undefined) {
      const value = prop.default;
      try { defaults[name] = JSON.parse(value); } catch {
        if (/^(['"]).*\1$/.test(value)) defaults[name] = value.slice(1, -1);
      }
    } else if (!prop.optional) {
      if (options?.length) defaults[name] = options[0];
      else if (primitive === 'boolean') defaults[name] = false;
      else if (primitive === 'number') defaults[name] = 1;
      else if (primitive === 'string' || /^(label|title|children|text|name)$/i.test(name)) defaults[name] = component.name;
    }
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!argTypes[name]) argTypes[name] = { name, type: typeof value };
    defaults[name] = value;
  }
  return { argTypes, defaults, callbacks };
}

function mountModule(component: ComponentEntry, require: NodeRequire) {
  const reference = JSON.stringify('./' + component.file.split('/').at(-1));
  const select = `const Component = source[${JSON.stringify(component.exportName || 'default')}];
if (!Component) throw new Error('The component export could not be found.');`;
  switch (component.framework) {
    case 'react': {
      const modern = resolveModule(require, 'react-dom/client');
      return `import { createElement } from 'react';
import ReactDOM from '${modern ? 'react-dom/client' : 'react-dom'}';
import * as source from ${reference};
${select}
export function mount(root, props) {
  ${modern ? 'const app = ReactDOM.createRoot(root); app.render(createElement(Component, props)); return () => app.unmount();' : 'ReactDOM.render(createElement(Component, props), root); return () => ReactDOM.unmountComponentAtNode(root);'}
}`;
    }
    case 'vue':
      return `import { createApp } from 'vue';
import * as source from ${reference};
${select}
export function mount(root, props) { const app = createApp(Component, props); app.mount(root); return () => app.unmount(); }`;
    case 'svelte': {
      const modern = Number(require('svelte/package.json').version.split('.')[0]) >= 5;
      return `${modern ? "import { mount as create, unmount } from 'svelte';" : ''}
import * as source from ${reference};
${select}
export function mount(root, props) {
  ${modern ? 'const app = create(Component, { target: root, props }); return () => unmount(app);' : 'const app = new Component({ target: root, props }); return () => app.$destroy();'}
}`;
    }
    default:
      throw new Error('This component needs a browser renderer. Scan the project with Claude to generate one for its source.');
  }
}

// The preview uses the same canvas message protocol as live layers and owns only its mount point.
function bridge(component: ComponentEntry, recipe: PreviewRecipe, mount: boolean) {
  const config = JSON.stringify({ key: componentKey(component), name: component.name, ...previewProps(component, recipe.props) });
  return `
const config = ${config};
const send = (type, data = {}) => parent.postMessage({ source: 'designer-probe', type, ...data }, '*');
const root = document.getElementById('designer-component') || document.body;
if (root === document.body) root.classList.add('designer-template');
let args = config.defaults;
let fixed = false;
let cleanup;
let last = '';
const report = (error) => {
  const message = error?.message || String(error);
  send('error', { message });
  root.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
};
addEventListener('error', (event) => report(event.error || event.message || 'A preview resource could not load.'));
addEventListener('unhandledrejection', (event) => report(event.reason));
function measure() {
  const rect = root.getBoundingClientRect();
  const w = Math.ceil(Math.max(rect.width, root.scrollWidth));
  const h = Math.ceil(Math.max(rect.height, root.scrollHeight));
  const node = root.firstElementChild;
  const rule = node && getComputedStyle(node);
  const styles = rule ? Object.fromEntries(['display','gap','backgroundColor','color','fontFamily','fontSize','fontWeight','borderTopLeftRadius','paddingTop','paddingRight','paddingBottom','paddingLeft','width','height'].map(key => [key, rule[key]])) : {};
  const next = JSON.stringify([w, h, styles]);
  if (next === last) return;
  last = next;
  if (!fixed && w && h) send('size', { w: Math.min(w, 8192), h: Math.min(h, 8192) });
  if (node) send('styles', { styles: { tag: node.localName, ...styles } });
}
async function start() {
  const adapter = ${mount ? "await import('./entry.js')" : 'undefined'};
  async function render() {
    await cleanup?.();
    cleanup = await adapter?.mount(root, { ...Object.fromEntries(config.callbacks.map(key => [key, () => {}])), ...args });
    measure();
  }
  let pending = Promise.resolve();
  addEventListener('message', ({ source, data }) => {
    if (source !== parent || data?.target !== 'designer-probe') return;
    if (data.type === 'set-args' && adapter && JSON.stringify(args) !== JSON.stringify(data.args)) {
      args = { ...config.defaults, ...data.args };
      pending = pending.then(render).catch(report);
    }
    if (data.type === 'hug' || data.type === 'fixed-size') {
      fixed = data.type === 'fixed-size';
      root.style.width = fixed ? Math.max(1, Number(data.w)) + 'px' : 'max-content';
      root.style.minHeight = fixed ? Math.max(1, Number(data.h)) + 'px' : '';
      last = '';
      measure();
    }
  });
  await render();
  new ResizeObserver(measure).observe(root);
  document.fonts?.ready.then(measure);
  send('ready');
  send('component', { componentId: config.key, name: config.name, argTypes: config.argTypes, initialArgs: config.defaults, args });
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => void start().catch(report), { once: true });
else void start().catch(report);
`;
}

const FRAME_CSS = 'html,body{background:transparent!important;margin:0!important;padding:0!important;overflow:hidden!important}#designer-component,body.designer-template{display:flow-root;width:max-content;max-width:none}';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json', '.wasm': 'application/wasm',
};

export class ComponentPreviews {
  private bundles = new Map<string, Bundle>();
  private ids = new Map<string, string>();
  private building = new Map<string, Promise<string>>();
  private installing = new Map<string, Promise<void>>();
  private generation = new AbortController();
  private server?: ReturnType<typeof createServer>;
  private listening?: Promise<string>;

  reset() {
    this.generation.abort();
    this.generation = new AbortController();
    this.bundles.clear();
    this.ids.clear();
    this.building.clear();
    this.installing.clear();
  }

  close() {
    this.reset();
    this.server?.close();
  }

  private origin() {
    if (!this.listening) this.listening = new Promise((done, fail) => {
      const server = this.server = createServer((req, res) => {
        const [id, ...path] = (req.url ?? '').split('?')[0].split('/').slice(1);
        let file: string;
        try {
          file = decodeURIComponent(path.join('/'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const value = this.bundles.get(id)?.files.get(file);
        if (value === undefined || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) {
          res.writeHead(404).end();
          return;
        }
        const origin = `http://${req.headers.host}`;
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} data: blob:; form-action 'none'; base-uri 'none'`,
        });
        res.end(value);
      });
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    return this.listening;
  }

  async render(project: string, component: ComponentEntry, recipe: PreviewRecipe = {}, rebuild = false) {
    const key = componentKey(component);
    const existing = this.ids.get(key);
    const cached = existing ? this.bundles.get(existing) : undefined;
    if (!rebuild && existing && cached) return `${await this.origin()}/${existing}/${cached.page.split('/').map(encodeURIComponent).join('/')}`;
    const current = this.building.get(key);
    if (current) return current;
    const signal = this.generation.signal;
    const build = this.bundle(project, component, recipe, signal).then(async (bundle) => {
      signal.throwIfAborted();
      const origin = await this.origin();
      signal.throwIfAborted();
      const id = existing ?? randomBytes(18).toString('hex');
      this.ids.set(key, id);
      this.bundles.set(id, bundle);
      return `${origin}/${id}/${bundle.page.split('/').map(encodeURIComponent).join('/')}`;
    });
    this.building.set(key, build);
    try {
      return await build;
    } finally {
      if (this.building.get(key) === build) this.building.delete(key);
    }
  }

  private async bundle(project: string, component: ComponentEntry, recipe: PreviewRecipe, signal: AbortSignal): Promise<Bundle> {
    const file = await componentPath(project, component.file);
    if (!file) throw new Error('The component source file no longer exists in this project.');
    const absolute = join(project, file);
    const root = await packageFolder(project, file);
    const from = createRequire(join(dirname(absolute), '__designer_preview__.cjs'));
    const template = !recipe.renderer && extname(file) === '.html';
    const required = FRAMEWORKS[component.framework];
    const pkg = await readPackageJson(root);
    const manager = await detectPackageManager(root, project);
    const hasDeps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).length > 0;
    const missing = required.some((name) => !resolveModule(from, name));
    if (hasDeps && !await exists(join(root, 'node_modules')) && !await exists(join(manager.root, 'node_modules')) && (missing || component.framework === 'custom')) {
      signal.throwIfAborted();
      let task = this.installing.get(manager.root);
      if (!task) {
        task = installDependencies(project, root, signal);
        this.installing.set(manager.root, task);
      }
      try { await task; } finally { if (this.installing.get(manager.root) === task) this.installing.delete(manager.root); }
    }
    signal.throwIfAborted();
    const plugins: PluginOption[] = [];
    if (!template && (component.framework === 'vue' || component.framework === 'svelte')) {
      const plugin = component.framework === 'vue' ? '@vitejs/plugin-vue' : '@sveltejs/vite-plugin-svelte';
      // ESM-only plugins are resolved with the import condition.
      let loaded;
      try {
        const pluginPath = resolveModule(from, plugin);
        if (!pluginPath) throw new Error('Compiler not installed');
        loaded = await import(pathToFileURL(pluginPath).href);
      } catch {
        throw new Error(`Could not load ${plugin} from the project. Its compiler is needed to mount this component.`);
      }
      plugins.push(component.framework === 'vue' ? loaded.default() : loaded.svelte());
    }

    const entry = join(dirname(absolute), '__designer_preview_mount__.js').split('\\').join('/');
    const styles = recipe.styles?.length ? recipe.styles.map((path) => join(project, path)) : await projectStyles(root, absolute);
    const resolveImports = styles.map((path) => `import ${JSON.stringify(path.split('\\').join('/'))};`).join('\n');
    plugins.push({
      name: 'designer-component-entry',
      resolveId: (id) => id === entry ? id : undefined,
      load: (id) => id === entry ? resolveImports + '\n' + (recipe.renderer ?? mountModule(component, from)) : undefined,
    });

    const { build } = await import('vite');
    const result = await build({
      root, base: './', configFile: false, envDir: false, logLevel: 'silent', publicDir: false, plugins,
      resolve: { tsconfigPaths: true, alias: Object.fromEntries(Object.entries(recipe.aliases ?? {}).map(([name, path]) => [name, join(project, path)])) },
      ...(component.framework === 'react' && { oxc: { jsx: { runtime: 'automatic' } } }),
      build: {
        write: false, minify: false, modulePreload: false,
        rolldownOptions: {
          input: template ? absolute : entry,
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'entry.js' },
        },
      },
    });
    if (!('output' in result)) throw new Error('The component build did not return browser files.');
    const files = new Map<string, string | Uint8Array>([['bridge.js', bridge(component, recipe, !template)], ['frame.css', FRAME_CSS]]);
    let page = 'index.html';
    let html = '';
    for (const item of result.output) {
      if (item.type === 'asset' && item.fileName.endsWith('.html')) {
        page = item.fileName;
        html = String(item.source);
      } else files.set(item.fileName, item.type === 'asset' ? item.source : item.code);
    }
    const prefix = '../'.repeat(page.split('/').length - 1) || './';
    const tags = `<link rel="stylesheet" href="${prefix}frame.css"><script type="module" src="${prefix}bridge.js"></script>`;
    if (template) {
      if (!/<head\b/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
      html = html.replace(/<\/head>/i, tags + '</head>');
    } else {
      const sheets = [...files.keys()].filter((name) => name.endsWith('.css') && name !== 'frame.css').map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
      html = `<!doctype html><html><head><meta charset="utf-8">${sheets}${tags}</head><body><div id="designer-component"></div></body></html>`;
    }
    files.set(page, html);
    return { page, files };
  }
}
