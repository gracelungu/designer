// Project facts read from files only: a quick guess at how a project runs (framework, package manager,
// dev command), handed to Claude as a starting point for setup (see runner.ts), and the component index.
// Nothing here executes the project's own code.

import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { ComponentEntry, ComponentProp, FrameworkId, PackageManager, ProjectPlan, StoryEntry } from '../shared/protocol.js';

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

// ----- Package manager -----

const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  // No lockfile yet, but a pnpm workspace file says which manager it is.
  ['pnpm-workspace.yaml', 'pnpm'],
];

/**
 * The package manager a project uses: its `packageManager` field, else its lockfile, looking up
 * through parent folders (a package inside a monorepo has its lockfile at the root). npm by default.
 */
export async function detectPackageManager(dir: string, stopAt?: string): Promise<{ pm: PackageManager; root: string; reason: string }> {
  let d = resolve(dir);
  const stop = stopAt ? resolve(stopAt) : undefined;
  for (let i = 0; i < 6; i++) {
    const pkg = await readPackageJson(d);
    const field = pkg?.packageManager && /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager);
    if (field) return { pm: field[1] as PackageManager, root: d, reason: `"packageManager" in ${relative(dir, join(d, 'package.json')) || 'package.json'}` };
    for (const [file, pm] of LOCKFILES) if (await exists(join(d, file))) return { pm, root: d, reason: relative(dir, join(d, file)) || file };
    if (d === stop || (await exists(join(d, '.git'))) || dirname(d) === d) break;
    d = dirname(d);
  }
  return { pm: 'npm', root: resolve(dir), reason: 'no lockfile, so npm' };
}

/** `npm run dev`, `pnpm run dev`, `yarn dev`, `bun run dev`, with extra args passed through the way each one expects. */
export function runScriptCommand(pm: PackageManager, script: string, args: string[] = []) {
  const base = pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
  if (!args.length) return base;
  return pm === 'npm' ? `${base} -- ${args.join(' ')}` : `${base} ${args.join(' ')}`;
}

export function installCommand(pm: PackageManager) {
  return `${pm} install`;
}

/** Run a package's binary without a script: `npx vite`, `pnpm exec vite`, `yarn vite`, `bunx vite`. */
export function execCommand(pm: PackageManager, bin: string) {
  return pm === 'npm' ? `npx --no-install ${bin}` : pm === 'pnpm' ? `pnpm exec ${bin}` : pm === 'yarn' ? `yarn ${bin}` : `bunx ${bin}`;
}

// ----- Framework -----

interface FrameworkRule {
  id: FrameworkId;
  name: string;
  deps: string[];
  /** The binary and arguments that start its dev server when the project has no script for it. */
  bin?: string;
  /** Script contents that mean "this runs the dev server". */
  scriptHint: RegExp;
  /** Reads the port from the PORT environment variable (so we can hand it a free one). */
  portEnv?: boolean;
  /** Takes --port N on the command line. */
  portFlag?: boolean;
  /** Stops to ask a question when its port is busy, so it must be given a free one. */
  asksWhenPortBusy?: boolean;
}

// Most specific first: a Next app also depends on react, a SvelteKit app on vite, and so on.
const FRAMEWORKS: FrameworkRule[] = [
  { id: 'next', name: 'Next.js', deps: ['next'], bin: 'next dev', scriptHint: /\bnext\s+dev\b|\bnext\b(?!\s+(build|start|lint|export))/, portEnv: true },
  { id: 'nuxt', name: 'Nuxt', deps: ['nuxt', 'nuxt3'], bin: 'nuxi dev', scriptHint: /\bnuxi?\s+dev\b/, portEnv: true },
  { id: 'remix', name: 'Remix', deps: ['@remix-run/dev'], bin: 'remix vite:dev', scriptHint: /\bremix\s+(vite:)?dev\b/, portEnv: true },
  { id: 'react-router', name: 'React Router', deps: ['@react-router/dev'], bin: 'react-router dev', scriptHint: /\breact-router\s+dev\b/, portFlag: true },
  { id: 'astro', name: 'Astro', deps: ['astro'], bin: 'astro dev', scriptHint: /\bastro\s+dev\b|^astro$/, portFlag: true },
  { id: 'sveltekit', name: 'SvelteKit', deps: ['@sveltejs/kit'], bin: 'vite dev', scriptHint: /\bvite(\s+dev)?\b/, portFlag: true },
  { id: 'gatsby', name: 'Gatsby', deps: ['gatsby'], bin: 'gatsby develop', scriptHint: /\bgatsby\s+develop\b/, portFlag: true },
  { id: 'angular', name: 'Angular', deps: ['@angular/core'], bin: 'ng serve', scriptHint: /\bng\s+serve\b/, portFlag: true, asksWhenPortBusy: true },
  { id: 'cra', name: 'Create React App', deps: ['react-scripts'], bin: 'react-scripts start', scriptHint: /\breact-scripts\s+start\b/, portEnv: true, asksWhenPortBusy: true },
  { id: 'vite', name: 'Vite', deps: ['vite'], bin: 'vite', scriptHint: /\bvite(?!\s+(build|preview))\b/, portFlag: true },
  { id: 'parcel', name: 'Parcel', deps: ['parcel'], bin: 'parcel', scriptHint: /\bparcel(?!\s+build)\b/, portFlag: true },
  { id: 'webpack', name: 'webpack', deps: ['webpack-dev-server'], bin: 'webpack serve', scriptHint: /\bwebpack(-dev-server|\s+serve)\b/, portFlag: true },
];

/** The UI library inside a bundler-only setup (Vite, Parcel, webpack), for a friendlier name. */
function uiLibrary(deps: Record<string, string>) {
  if (deps.react || deps.preact) return deps.preact ? 'Preact' : 'React';
  if (deps.vue) return 'Vue';
  if (deps.svelte) return 'Svelte';
  if (deps['solid-js']) return 'Solid';
  if (deps.lit) return 'Lit';
  return undefined;
}

export function detectFramework(pkg: PackageJson | undefined): { id: FrameworkId; name: string; rule?: FrameworkRule } {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const rule of FRAMEWORKS) {
    if (rule.deps.some((d) => d in deps)) {
      const lib = ['vite', 'parcel', 'webpack'].includes(rule.id) ? uiLibrary(deps) : undefined;
      return { id: rule.id, name: lib ? `${lib} + ${rule.name}` : rule.name, rule };
    }
  }
  if (pkg) return { id: 'node', name: uiLibrary(deps) ?? 'Node project' };
  return { id: 'unknown', name: 'Unknown' };
}

/** Script names people use for "run the app locally", best first. */
const DEV_SCRIPT_NAMES = ['dev', 'start', 'develop', 'serve', 'dev:web', 'web', 'start:dev'];

/** Picks the script that starts the dev server. Scripts that build, test or lint never count. */
export function pickDevScript(scripts: Record<string, string>, rule?: FrameworkRule): string | undefined {
  const usable = (name: string) => {
    const body = scripts[name];
    if (!body) return false;
    if (/^(build|test|lint|format|typecheck|preview|storybook|build-storybook)\b/.test(name)) return false;
    // `start` is often the production server (`next start`): only take it when it runs the dev server.
    if (rule && name === 'start' && !rule.scriptHint.test(body)) return false;
    return true;
  };
  if (rule) {
    const byContent = DEV_SCRIPT_NAMES.find((n) => usable(n) && rule.scriptHint.test(scripts[n]));
    if (byContent) return byContent;
    const any = Object.keys(scripts).find((n) => usable(n) && rule.scriptHint.test(scripts[n]) && !/build|test|lint/.test(n));
    if (any) return any;
  }
  return DEV_SCRIPT_NAMES.find(usable);
}

// ----- Monorepos -----

async function workspacePatterns(root: string, pkg?: PackageJson): Promise<string[]> {
  const fromPkg = Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? []);
  const pnpm = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8').catch(() => '');
  const fromPnpm = [...pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]);
  return [...fromPkg, ...fromPnpm].filter((p) => !p.startsWith('!'));
}

/** Package folders in a workspace. Handles `apps/*`, `packages/**` and plain paths. */
export async function workspacePackages(root: string): Promise<string[]> {
  const pkg = await readPackageJson(root);
  const out: string[] = [];
  for (const pattern of await workspacePatterns(root, pkg)) {
    const clean = pattern.replace(/\/\*\*?$/, '');
    if (clean.includes('*')) continue;
    if (pattern.endsWith('*')) {
      const entries = await readdir(join(root, clean), { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory() && (await exists(join(root, clean, e.name, 'package.json')))) out.push(join(root, clean, e.name));
    } else if (await exists(join(root, clean, 'package.json'))) out.push(join(root, clean));
  }
  return [...new Set(out)].sort();
}

/** In a monorepo whose root is not an app itself, the package that is the main web app. */
async function pickWorkspaceApp(root: string) {
  const candidates: { dir: string; score: number }[] = [];
  for (const dir of await workspacePackages(root)) {
    const pkg = await readPackageJson(dir);
    const fw = detectFramework(pkg);
    if (!fw.rule || !pickDevScript(pkg?.scripts ?? {}, fw.rule)) continue;
    const rel = relative(root, dir).replace(/\\/g, '/');
    let score = 1;
    if (rel.startsWith('apps/')) score += 4;
    if (/(^|\/)(web|app|site|frontend|client|www)$/.test(rel)) score += 3;
    if (/docs|storybook|example|playground|e2e/.test(rel)) score -= 3;
    candidates.push({ dir, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  return candidates[0]?.dir;
}

// ----- The plan -----

/**
 * Everything Designer needs to run a project, worked out from its files: which folder the app
 * lives in, its framework, package manager, whether it needs installing, and the command to start it.
 */
export async function planProject(cwd: string): Promise<ProjectPlan> {
  const root = resolve(cwd);
  let appDir = root;
  let pkg = await readPackageJson(root);
  let fw = detectFramework(pkg);
  const isWorkspace = (await workspacePatterns(root, pkg)).length > 0;
  if (isWorkspace && (!fw.rule || !pickDevScript(pkg?.scripts ?? {}, fw.rule))) {
    const sub = await pickWorkspaceApp(root);
    if (sub) {
      appDir = sub;
      pkg = await readPackageJson(sub);
      fw = detectFramework(pkg);
    }
  }
  const { pm, root: installRoot, reason } = await detectPackageManager(appDir, root);
  const scripts = pkg?.scripts ?? {};
  const script = pickDevScript(scripts, fw.rule);
  const notes: string[] = [];

  let devCommand: string | undefined;
  if (script) devCommand = runScriptCommand(pm, script);
  else if (fw.rule?.bin) {
    devCommand = execCommand(pm, fw.rule.bin);
    notes.push(`No dev script in package.json, so Designer runs ${fw.name} directly.`);
  } else if (!pkg && (await exists(join(root, 'index.html')))) {
    devCommand = 'static';
    notes.push('A plain HTML site: Designer serves the folder itself.');
  }

  const needsInstall = !!pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0 && !(await exists(join(appDir, 'node_modules'))) && !(await exists(join(installRoot, 'node_modules')));
  const hasStorybook = 'storybook' in scripts || (await exists(join(appDir, '.storybook'))) || (await exists(join(root, '.storybook')));

  return {
    framework: fw.id,
    frameworkName: fw.name,
    packageManager: pm,
    packageManagerReason: reason,
    appDir: relative(root, appDir).replace(/\\/g, '/') || '.',
    installDir: relative(root, installRoot).replace(/\\/g, '/') || '.',
    devScript: script,
    devCommand,
    installCommand: pkg ? installCommand(pm) : undefined,
    needsInstall,
    portEnv: !!fw.rule?.portEnv,
    portFlag: !!fw.rule?.portFlag,
    asksWhenPortBusy: !!fw.rule?.asksWhenPortBusy,
    hasStorybook,
    notes,
  };
}

/** A free TCP port on loopback. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });
}

/**
 * The command and environment that start the dev server on a known-free port where the framework
 * lets us choose one, so it never stops to ask "port 3000 is busy, use another?".
 */
export function devLaunch(plan: ProjectPlan, port: number): { command: string; env: Record<string, string> } | undefined {
  if (!plan.devCommand) return undefined;
  if (plan.devCommand === 'static') return { command: staticServerCommand(port), env: {} };
  const env: Record<string, string> = { BROWSER: 'none', NO_COLOR: '1' };
  let command = plan.devCommand;
  if (plan.portEnv) env.PORT = String(port);
  if (plan.portFlag && plan.asksWhenPortBusy) {
    // Only frameworks that would otherwise ask get a flag added: an added flag can clash with a script's own.
    command = plan.devScript ? runScriptCommand(plan.packageManager, plan.devScript, ['--port', String(port)]) : `${command} --port ${port}`;
  }
  return { command, env };
}

/** A tiny static file server for plain HTML folders, run with the same Node that runs Designer. */
export function staticServerCommand(port: number) {
  const src = `const h=require('http'),f=require('fs'),p=require('path'),r=process.cwd(),t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};h.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);let x=p.join(r,p.normalize(u));if(!x.startsWith(r))return s.writeHead(403).end();try{if(f.statSync(x).isDirectory())x=p.join(x,'index.html');s.writeHead(200,{'content-type':t[p.extname(x)]||'application/octet-stream'});f.createReadStream(x).pipe(s)}catch{s.writeHead(404).end('Not found')}}).listen(${port},'127.0.0.1',()=>console.log('Local: http://localhost:${port}/'))`;
  return `"${process.execPath}" -e "${src.replace(/"/g, '\\"')}"`;
}

// ----- Component index -----

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.astro', 'out', 'coverage', 'storybook-static', '.turbo', 'public', 'static', '.output', 'vendor', '__tests__', '__mocks__', 'e2e', 'cypress', 'playwright']);
/** Files that are routes, pages or app entry points rather than reusable components. */
const NOT_COMPONENT = /(^|\/)(pages|routes)\/|(^|\/)app\/(.*\/)?(page|layout|loading|error|not-found|template|route|default)\.[jt]sx?$|(^|\/)(main|App|_app|_document|root|entry\.(client|server)|setupTests|vite-env\.d)\.[jt]sx?$|(^|\/)App\.(vue|svelte)$|\.(stories|story|test|spec|d)\.[jt]sx?$|\+(page|layout|error)\.svelte$/;

async function walkSources(dir: string, root: string, acc: string[], depth = 0) {
  if (depth > 10 || acc.length >= 2000) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walkSources(p, root, acc, depth + 1);
    } else if (/\.(tsx|jsx|vue|svelte)$/.test(e.name) || /\.[jt]s$/.test(e.name) && /components?\//.test(relative(root, p))) acc.push(p);
  }
}

const isPascal = (s: string) => /^[A-Z][A-Za-z0-9]*$/.test(s);

/** Members of a TypeScript object type body: `label: string; size?: 'sm' | 'md'`. Nested objects are skipped over. */
export function parseTypeMembers(body: string): ComponentProp[] {
  const props: ComponentProp[] = [];
  const member = /^\s*(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?(\?)?\s*:\s*([\s\S]+?)\s*$/;
  const flush = (text: string) => {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').trim();
    const m = member.exec(clean);
    if (m) props.push({ name: m[1], type: m[3].replace(/\s+/g, ' ').replace(/^\|\s*/, '').replace(/[;,]$/, '').trim(), optional: !!m[2] });
  };
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ('{([<'.includes(ch)) depth++;
    if ('})]'.includes(ch) || (ch === '>' && body[i - 1] !== '=')) depth--;
    if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) {
      if (ch === '\n') {
        // A member continues on the next line when its type has not started yet ("size?:")
        // or the next line carries on a union ("| 'md'").
        const rest = body.slice(i + 1).trimStart();
        if (/:\s*$/.test(current) || /\|\s*$/.test(current) || rest.startsWith('|')) {
          current += ' ';
          continue;
        }
      }
      if (current.trim()) flush(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) flush(current);
  return props;
}

/** The text between a `{` at `start` and its matching `}`. */
function block(src: string, start: number) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return '';
}

function typeBody(src: string, typeName: string) {
  const re = new RegExp(`(?:interface\\s+${typeName}(?:<[^>]*>)?(?:\\s+extends\\s+[^{]+)?|type\\s+${typeName}(?:<[^>]*>)?\\s*=\\s*(?:[^{;]*&\\s*)?)\\s*\\{`);
  const m = re.exec(src);
  return m ? block(src, m.index + m[0].length - 1) : undefined;
}

/** `{ variant = 'primary', size, ...rest }` → names and defaults. */
function destructured(params: string): ComponentProp[] {
  const props: ComponentProp[] = [];
  let depth = 0;
  let cur = '';
  const push = () => {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*)?\s*(?:=\s*([\s\S]+))?$/.exec(cur);
    if (m && !cur.trim().startsWith('...')) props.push({ name: m[1], optional: m[2] !== undefined, default: m[2]?.trim() });
    cur = '';
  };
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if ('{([<'.includes(ch)) depth++;
    if ('})]'.includes(ch) || (ch === '>' && params[i - 1] !== '=')) depth--;
    if (depth === 0 && ch === ',') push();
    else cur += ch;
  }
  if (cur.trim()) push();
  return props;
}

function mergeProps(typed: ComponentProp[], fromParams: ComponentProp[]): ComponentProp[] {
  if (!typed.length) return fromParams;
  return typed.map((p) => {
    const d = fromParams.find((x) => x.name === p.name);
    return d?.default !== undefined ? { ...p, default: d.default, optional: true } : p;
  });
}

/** React (and Preact/Solid) components a file exports: PascalCase functions, arrows, forwardRef/memo wrappers. */
export function parseReactComponents(src: string): { exportName: string; name: string; props: ComponentProp[]; isDefault: boolean }[] {
  const found = new Map<string, { exportName: string; name: string; props: ComponentProp[]; isDefault: boolean }>();
  const propsFor = (name: string, paramsStart: number, explicitType?: string) => {
    const typeName = explicitType ?? `${name}Props`;
    const body = typeBody(src, typeName) ?? (explicitType === undefined ? typeBody(src, 'Props') : undefined);
    const typed = body ? parseTypeMembers(body) : [];
    let params: ComponentProp[] = [];
    const open = src.indexOf('{', paramsStart);
    if (open !== -1 && /^\s*\(?\s*$/.test(src.slice(paramsStart, open))) params = destructured(block(src, open));
    return mergeProps(typed, params);
  };
  const add = (name: string, exportName: string, isDefault: boolean, paramsStart: number, typeName?: string) => {
    if (!isPascal(name) || found.has(exportName)) return;
    found.set(exportName, { exportName, name, props: propsFor(name, paramsStart, typeName), isDefault });
  };
  let m: RegExpExecArray | null;
  const fnRe = /export\s+(default\s+)?function\s+([A-Z][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = fnRe.exec(src))) {
    const typeAnn = /^\s*\{[^}]*\}\s*:\s*([A-Z][\w$]*)/.exec(src.slice(m.index + m[0].length));
    add(m[2], m[1] ? 'default' : m[2], !!m[1], m.index + m[0].length, typeAnn?.[1]);
  }
  const constRe = /export\s+const\s+([A-Z][\w$]*)\s*(?::\s*[\w$.<>, ]+)?=\s*(?:(?:React\.)?(?:forwardRef|memo)\s*(?:<\s*[^,>]+,\s*([A-Z][\w$]*)\s*>)?\s*\(\s*(?:function\s*\w*)?\s*)?(?:<[^>]*>)?\s*\(/g;
  while ((m = constRe.exec(src))) {
    const typeAnn = /^\s*\{[\s\S]*?\}\s*:\s*([A-Z][\w$]*)/.exec(src.slice(m.index + m[0].length, m.index + m[0].length + 400));
    add(m[1], m[1], false, m.index + m[0].length, m[2] ?? typeAnn?.[1]);
  }
  // `function Card() {}` … `export default Card` / `export { Card }`
  const local = /(?:^|\n)\s*(?:const|function)\s+([A-Z][\w$]*)\s*(?::[^=]+)?(?:=\s*(?:\([^)]*\)|[\w$]+)\s*=>|=\s*(?:React\.)?(?:forwardRef|memo)|\()/g;
  const locals = new Map<string, number>();
  while ((m = local.exec(src))) locals.set(m[1], m.index + m[0].length);
  const def = /export\s+default\s+(?:(?:React\.)?(?:memo|forwardRef)\()?([A-Z][\w$]*)\)?\s*;?\s*$/m.exec(src);
  if (def && locals.has(def[1])) add(def[1], 'default', true, locals.get(def[1])!);
  for (const e of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of e[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (locals.has(orig)) add(alias && alias !== 'default' ? alias : orig, alias ?? orig, alias === 'default', locals.get(orig)!);
    }
  }
  // Only files that render something: JSX, createElement, or h().
  if (!/<[A-Za-z][\w.]*[\s/>]|createElement\(|\bh\(/.test(src)) return [];
  return [...found.values()];
}

/** Props of a Vue single-file component: `defineProps<{...}>()`, `defineProps({...})` or `props: {...}`. */
export function parseVueProps(src: string): ComponentProp[] {
  const generic = /defineProps<\s*\{/.exec(src);
  if (generic) return parseTypeMembers(block(src, generic.index + generic[0].length - 1));
  const typed = /defineProps<\s*([A-Z][\w$]*)\s*>/.exec(src);
  if (typed) return parseTypeMembers(typeBody(src, typed[1]) ?? '');
  const obj = /(?:defineProps\(\s*|props\s*:\s*)\{/.exec(src);
  if (obj) {
    const body = block(src, obj.index + obj[0].length - 1);
    const out: ComponentProp[] = [];
    let depth = 0;
    let cur = '';
    const text = body + ',';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if ('{([<'.includes(ch)) depth++;
      if ('})]'.includes(ch) || (ch === '>' && text[i - 1] !== '=')) depth--;
      if (depth === 0 && ch === ',') {
        const m = /^\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([\s\S]+)$/.exec(cur);
        if (m) {
          const type = /type\s*:\s*(\[[^\]]*\]|[\w$.]+)/.exec(m[2])?.[1] ?? m[2].trim();
          const def = /default\s*:\s*([^,}\n]+)/.exec(m[2])?.[1]?.trim();
          out.push({ name: m[1], type: type.trim(), optional: !/required\s*:\s*true/.test(m[2]), default: def });
        }
        cur = '';
      } else cur += ch;
    }
    return out;
  }
  const arr = /defineProps\(\s*\[([^\]]*)\]/.exec(src);
  if (arr) return [...arr[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => ({ name: x[1], optional: true }));
  return [];
}

/** Props of a Svelte component: Svelte 5 `$props()` or Svelte 4 `export let`. */
export function parseSvelteProps(src: string): ComponentProp[] {
  const runes = /let\s*\{([\s\S]*?)\}\s*(?::\s*([A-Z][\w$]*))?\s*=\s*\$props\(\)/.exec(src);
  if (runes) {
    const params = destructured(runes[1]);
    const typed = runes[2] ? parseTypeMembers(typeBody(src, runes[2]) ?? '') : [];
    return mergeProps(typed, params);
  }
  return [...src.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;\n]+))?(?:=\s*([^;\n]+))?/g)].map((m) => ({
    name: m[1],
    type: m[2]?.trim(),
    optional: m[3] !== undefined,
    default: m[3]?.trim(),
  }));
}

/** Pairs a component with the stories that render it: same folder and name, or a story titled after it. */
function storiesFor(file: string, name: string, stories: StoryEntry[]) {
  const dir = dirname(file);
  const base = basename(file, extname(file));
  return stories
    .filter((s) => {
      const sBase = basename(s.file).replace(/\.stories\.[jt]sx?$/, '');
      const sameFile = dirname(s.file) === dir && (sBase === base || sBase === name);
      const titled = s.title.split('/').pop()?.replace(/\s+/g, '') === name;
      return sameFile || titled;
    })
    .flatMap((s) => s.stories.map((x) => x.id));
}

/**
 * Lists the reusable components in a project with their props, by reading source files (React,
 * Vue and Svelte), and links each to its Storybook stories when it has any.
 */
export async function indexComponents(cwd: string, stories: StoryEntry[] = []): Promise<ComponentEntry[]> {
  const files: string[] = [];
  await walkSources(cwd, cwd, files);
  const out: ComponentEntry[] = [];
  for (const abs of files) {
    const file = relative(cwd, abs).replace(/\\/g, '/');
    if (NOT_COMPONENT.test(file)) continue;
    const src = await readFile(abs, 'utf8').catch(() => '');
    if (!src || src.length > 300_000) continue;
    const ext = extname(file);
    if (ext === '.vue' || ext === '.svelte') {
      const name = basename(file, ext);
      if (!isPascal(name)) continue;
      const props = ext === '.vue' ? parseVueProps(src) : parseSvelteProps(src);
      out.push({ name, file, exportName: 'default', framework: ext === '.vue' ? 'vue' : 'svelte', props, storyIds: storiesFor(file, name, stories) });
      continue;
    }
    for (const c of parseReactComponents(src)) {
      out.push({ name: c.name, file, exportName: c.exportName, framework: 'react', props: c.props, storyIds: storiesFor(file, c.name, stories) });
    }
    if (out.length >= 1000) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}
