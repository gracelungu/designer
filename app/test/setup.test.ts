import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectFramework,
  detectPackageManager,
  devLaunch,
  execCommand,
  indexComponents,
  parseReactComponents,
  parseSvelteProps,
  parseTypeMembers,
  parseVueProps,
  pickDevScript,
  planProject,
  runScriptCommand,
  workspacePackages,
} from '../src/server/setup';
import { findStories } from '../src/server/project';

const fx = (name: string) => join(__dirname, 'fixtures', 'projects', name);

describe('package manager', () => {
  it.each([
    ['next-pnpm', 'pnpm'],
    ['vite-react-yarn', 'yarn'],
    ['vue-vite-npm', 'npm'],
    ['sveltekit-bun', 'bun'],
    ['cra-npm', 'npm'],
    ['angular-yarn', 'yarn'],
    ['static-html', 'npm'],
  ])('%s uses %s', async (name, pm) => {
    expect((await detectPackageManager(fx(name), fx(name))).pm).toBe(pm);
  });
  it('the packageManager field wins over lockfiles', async () => {
    const d = await detectPackageManager(fx('angular-yarn'));
    expect(d.reason).toMatch(/packageManager/);
  });
  it('a package inside a monorepo uses the root lockfile', async () => {
    const d = await detectPackageManager(fx('monorepo-pnpm/apps/web'), fx('monorepo-pnpm'));
    expect(d.pm).toBe('pnpm');
    expect(d.root).toBe(fx('monorepo-pnpm'));
  });
  it('a pnpm workspace file means pnpm even before there is a lockfile', async () => {
    const d = mkdtempSync(join(tmpdir(), 'designer-pnpmws-'));
    writeFileSync(join(d, 'package.json'), '{}');
    writeFileSync(join(d, 'pnpm-workspace.yaml'), 'packages: []');
    expect((await detectPackageManager(d)).pm).toBe('pnpm');
  });
  it('builds commands the way each manager expects', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(runScriptCommand('npm', 'start', ['--port', '4000'])).toBe('npm run start -- --port 4000');
    expect(runScriptCommand('pnpm', 'start', ['--port', '4000'])).toBe('pnpm run start --port 4000');
    expect(runScriptCommand('yarn', 'dev')).toBe('yarn dev');
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev');
    expect(execCommand('npm', 'vite')).toBe('npx --no-install vite');
    expect(execCommand('pnpm', 'vite')).toBe('pnpm exec vite');
  });
});

describe('framework and dev script', () => {
  it('names the framework, most specific first', () => {
    expect(detectFramework({ dependencies: { next: '1', react: '1' } }).id).toBe('next');
    expect(detectFramework({ devDependencies: { '@sveltejs/kit': '1', vite: '1' } }).id).toBe('sveltekit');
    expect(detectFramework({ devDependencies: { vite: '1' }, dependencies: { vue: '3' } }).name).toBe('Vue + Vite');
    expect(detectFramework({ dependencies: { 'react-scripts': '5' } }).id).toBe('cra');
    expect(detectFramework({}).id).toBe('node');
    expect(detectFramework(undefined).id).toBe('unknown');
  });
  it('never takes a production start or a build script for the dev server', () => {
    const next = detectFramework({ dependencies: { next: '1' } }).rule;
    expect(pickDevScript({ start: 'next start', build: 'next build' }, next)).toBeUndefined();
    expect(pickDevScript({ start: 'next start', dev: 'next dev' }, next)).toBe('dev');
    expect(pickDevScript({ 'dev:app': 'next dev -p 4000', build: 'next build' }, next)).toBe('dev:app');
    const vite = detectFramework({ devDependencies: { vite: '1' } }).rule;
    expect(pickDevScript({ preview: 'vite preview', build: 'vite build' }, vite)).toBeUndefined();
  });
});

describe('planProject on fixture repos', () => {
  it.each([
    ['next-pnpm', { framework: 'next', packageManager: 'pnpm', devCommand: 'pnpm run dev', portEnv: true }],
    ['vite-react-yarn', { framework: 'vite', frameworkName: 'React + Vite', packageManager: 'yarn', devCommand: 'yarn dev', hasStorybook: true }],
    ['vue-vite-npm', { framework: 'vite', frameworkName: 'Vue + Vite', packageManager: 'npm', devCommand: 'npm run dev' }],
    ['sveltekit-bun', { framework: 'sveltekit', packageManager: 'bun', devCommand: 'bun run dev' }],
    ['cra-npm', { framework: 'cra', devCommand: 'npm run start', asksWhenPortBusy: true }],
    ['angular-yarn', { framework: 'angular', packageManager: 'yarn', devCommand: 'yarn start' }],
    ['vite-no-script', { framework: 'vite', devCommand: 'npx --no-install vite' }],
    ['static-html', { framework: 'unknown', devCommand: 'static', installCommand: undefined, needsInstall: false }],
  ])('%s', async (name, expected) => {
    expect(await planProject(fx(name))).toMatchObject(expected);
  });
  it('fixture repos without node_modules need installing', async () => {
    expect((await planProject(fx('next-pnpm'))).needsInstall).toBe(true);
  });
  it('finds the web app in a monorepo whose root does not run anything', async () => {
    expect(await workspacePackages(fx('monorepo-pnpm'))).toHaveLength(3);
    const plan = await planProject(fx('monorepo-pnpm'));
    expect(plan).toMatchObject({ appDir: 'apps/web', installDir: '.', framework: 'next', packageManager: 'pnpm', devCommand: 'pnpm run dev' });
  });
  it('gives a free port so a dev server never stops to ask about a busy one', async () => {
    const next = devLaunch(await planProject(fx('next-pnpm')), 4123)!;
    expect(next).toMatchObject({ command: 'pnpm run dev', env: { PORT: '4123', BROWSER: 'none' } });
    const ng = devLaunch(await planProject(fx('angular-yarn')), 4124)!;
    expect(ng.command).toBe('yarn start --port 4124');
    const cra = devLaunch(await planProject(fx('cra-npm')), 4125)!;
    expect(cra.env.PORT).toBe('4125');
    const vite = devLaunch(await planProject(fx('vue-vite-npm')), 4126)!;
    expect(vite.command).toBe('npm run dev');
    expect(devLaunch(await planProject(fx('static-html')), 4127)!.command).toContain('listen(4127');
  });
  it('an empty folder has nothing to run', async () => {
    const d = mkdtempSync(join(tmpdir(), 'designer-empty-'));
    const plan = await planProject(d);
    expect(plan.devCommand).toBeUndefined();
    expect(devLaunch(plan, 1)).toBeUndefined();
  });
  it('a project with no dependencies does not need installing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'designer-nodeps-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'node x.js' } }));
    expect((await planProject(d)).needsInstall).toBe(false);
  });
});

describe('component parsing', () => {
  it('reads TypeScript prop types, multi-line unions included', () => {
    expect(parseTypeMembers(`label: string;\n  variant?: 'a' | 'b';\n  size?:\n    | 'sm'\n    | 'md';\n  onClick?: (e: { x: number; y: number }) => void;`)).toEqual([
      { name: 'label', type: 'string', optional: false },
      { name: 'variant', type: "'a' | 'b'", optional: true },
      { name: 'size', type: "'sm' | 'md'", optional: true },
      { name: 'onClick', type: '(e: { x: number; y: number }) => void', optional: true },
    ]);
  });
  it('finds function, arrow, forwardRef and default-exported React components', () => {
    const src = `
      import { forwardRef } from 'react';
      export interface ButtonProps { label: string; size?: 'sm' | 'md' }
      export function Button({ label, size = 'md' }: ButtonProps) { return <button>{label}</button>; }
      export const Icon = ({ name }: { name: string }) => <i>{name}</i>;
      type InputProps = { value: string };
      export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => <input ref={ref} />);
      function Card({ title }) { return <div>{title}</div>; }
      export default Card;
      export const helper = () => 1;
      export const THEME = {};
    `;
    const found = parseReactComponents(src);
    expect(found.map((c) => [c.name, c.exportName])).toEqual([
      ['Button', 'Button'],
      ['Icon', 'Icon'],
      ['Input', 'Input'],
      ['Card', 'default'],
    ]);
    expect(found[0].props).toEqual([
      { name: 'label', type: 'string', optional: false },
      { name: 'size', type: "'sm' | 'md'", optional: true, default: "'md'" },
    ]);
    expect(found[1].props.map((p) => p.name)).toEqual(['name']);
    expect(found[2].props.map((p) => p.name)).toEqual(['value']);
    expect(found[3].props.map((p) => p.name)).toEqual(['title']);
  });
  it('keeps going past function-typed props', () => {
    expect(parseTypeMembers('onClick?: () => void;\n  label: string;').map((p) => p.name)).toEqual(['onClick', 'label']);
  });
  it('ignores files that render nothing', () => {
    expect(parseReactComponents('export const Config = () => ({ a: 1 });')).toEqual([]);
  });
  it('reads Vue props in all three styles', () => {
    expect(parseVueProps('defineProps<{ title: string; subtitle?: string }>()').map((p) => [p.name, p.optional])).toEqual([
      ['title', false],
      ['subtitle', true],
    ]);
    expect(parseVueProps("props: { on: { type: Boolean, default: false }, label: { type: String, required: true } }")).toEqual([
      { name: 'on', type: 'Boolean', optional: true, default: 'false' },
      { name: 'label', type: 'String', optional: false, default: undefined },
    ]);
    expect(parseVueProps("defineProps(['a', 'b'])").map((p) => p.name)).toEqual(['a', 'b']);
  });
  it('reads Svelte 5 and Svelte 4 props', () => {
    expect(parseSvelteProps("let { label, selected = false } = $props();")).toEqual([
      { name: 'label', optional: false, default: undefined },
      { name: 'selected', optional: true, default: 'false' },
    ]);
    expect(parseSvelteProps('export let name;\nexport let count: number = 0;').map((p) => [p.name, p.type, p.default])).toEqual([
      ['name', undefined, undefined],
      ['count', 'number', '0'],
    ]);
  });
});

describe('indexComponents on fixture repos', () => {
  const names = async (name: string) => {
    const dir = fx(name);
    return (await indexComponents(dir, await findStories(dir))).map((c) => `${c.name}@${c.file}${c.storyIds.length ? ` [${c.storyIds.join(',')}]` : ''}`);
  };
  it('Next: components, not pages, layouts or helpers', async () => {
    expect(await names('next-pnpm')).toEqual(['Button@components/Button.tsx', 'Card@components/Card.tsx']);
  });
  it('Vite React: forwardRef, index files, and links stories', async () => {
    expect(await names('vite-react-yarn')).toEqual([
      'Avatar@src/components/Avatar/index.tsx',
      'Badge@src/components/Badge.tsx',
      'Button@src/components/Button.tsx [inputs-button--primary,inputs-button--disabled]',
    ]);
  });
  it('Vue single-file components, not App.vue', async () => {
    const list = await indexComponents(fx('vue-vite-npm'));
    expect(list.map((c) => c.name)).toEqual(['AppHeader', 'Toggle']);
    expect(list[0].props.map((p) => p.name)).toEqual(['title', 'subtitle']);
    expect(list[0].framework).toBe('vue');
  });
  it('Svelte components, not routes', async () => {
    const list = await indexComponents(fx('sveltekit-bun'));
    expect(list.map((c) => c.name)).toEqual(['Chip', 'Legacy']);
    expect(list[1].props.map((p) => p.name)).toEqual(['name', 'count']);
  });
  it('monorepo packages are indexed too', async () => {
    expect(await names('monorepo-pnpm')).toEqual(['Tag@packages/ui/src/Tag.tsx']);
  });
});
