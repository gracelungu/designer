// Real-world smoke test: scaffolds small apps for several stacks, then lets Designer's setup (the real,
// signed-in Claude Code on this computer) work out how each runs, install it and start its dev server.
// Needs the network, Claude Code and a few minutes, so it only runs with DESIGNER_SMOKE_REAL=1
// (npm run test:smoke:setup).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findClaude } from '../src/server/claude';
import { startServer } from '../src/server/index';
import type { ComponentEntry, PackageManager, SetupState } from '../src/shared/protocol';

const enabled = process.env.DESIGNER_SMOKE_REAL === '1' && !!findClaude();
const has = (bin: string) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function scaffold(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'designer-real-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

const lock: Record<PackageManager | 'none', Record<string, string>> = {
  none: {},
  npm: {},
  pnpm: { 'pnpm-workspace.yaml': 'packages: []\n' },
  yarn: { 'yarn.lock': '' },
  bun: { 'bun.lock': '' },
};

const cases: { name: string; pm: PackageManager | 'none'; files: Record<string, string>; expectHtml: RegExp; components: string[] }[] = [
  {
    name: 'React + Vite',
    pm: 'npm',
    files: {
      'package.json': JSON.stringify({ name: 'r', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19', 'react-dom': '^19' }, devDependencies: { vite: '^8', '@vitejs/plugin-react': '^6' } }),
      'vite.config.js': "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n",
      'index.html': '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
      'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport { Button } from './components/Button';\ncreateRoot(document.getElementById('root')).render(<Button label=\"Hi\" />);\n",
      'src/components/Button.jsx': 'export function Button({ label, tone = "dark" }) { return <button data-tone={tone}>{label}</button>; }\n',
    },
    expectHtml: /<div id="root">/,
    components: ['Button'],
  },
  {
    name: 'Vue + Vite',
    pm: 'pnpm',
    files: {
      'package.json': JSON.stringify({ name: 'v', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { vue: '^3' }, devDependencies: { vite: '^8', '@vitejs/plugin-vue': 'latest' } }),
      'vite.config.js': "import vue from '@vitejs/plugin-vue';\nexport default { plugins: [vue()] };\n",
      'index.html': '<!doctype html><div id="app"></div><script type="module" src="/src/main.js"></script>',
      'src/main.js': "import { createApp } from 'vue';\nimport Hello from './components/Hello.vue';\ncreateApp(Hello, { name: 'x' }).mount('#app');\n",
      'src/components/Hello.vue': '<script setup>\ndefineProps({ name: { type: String, required: true } });\n</script>\n<template><p>Hello {{ name }}</p></template>\n',
    },
    expectHtml: /<div id="app">/,
    components: ['Hello'],
  },
  {
    name: 'Next.js',
    pm: 'yarn',
    files: {
      'package.json': JSON.stringify({ name: 'n', private: true, scripts: { dev: 'next dev', start: 'next start' }, dependencies: { next: '^16', react: '^19', 'react-dom': '^19' } }),
      'app/layout.jsx': 'export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n',
      'app/page.jsx': "import { Hero } from '../components/Hero';\nexport default function Page() { return <Hero title=\"Hello from Next\" />; }\n",
      'components/Hero.jsx': 'export function Hero({ title }) { return <h1>{title}</h1>; }\n',
    },
    expectHtml: /Hello from Next/,
    components: ['Hero'],
  },
  {
    name: 'Svelte + Vite',
    pm: 'bun',
    files: {
      'package.json': JSON.stringify({ name: 's', private: true, type: 'module', scripts: { dev: 'vite' }, devDependencies: { vite: '^8', svelte: '^5', '@sveltejs/vite-plugin-svelte': 'latest' } }),
      'vite.config.js': "import { svelte } from '@sveltejs/vite-plugin-svelte';\nexport default { plugins: [svelte()] };\n",
      'index.html': '<!doctype html><div id="s"></div><script type="module" src="/src/main.js"></script>',
      'src/main.js': "import { mount } from 'svelte';\nimport Chip from './lib/Chip.svelte';\nmount(Chip, { target: document.getElementById('s'), props: { label: 'x' } });\n",
      'src/lib/Chip.svelte': '<script>\n  let { label, on = false } = $props();\n</script>\n<span class:on>{label}</span>\n',
    },
    expectHtml: /<div id="s">/,
    components: ['Chip'],
  },
  {
    // Not a JavaScript project at all: setup is not only for Storybook or Node.
    name: 'Python site',
    pm: 'none',
    files: {
      'README.md': '# Brochure\n\nRun it with `python3 serve.py` (reads PORT, default 8000).\n',
      'serve.py': "import http.server, os, socketserver\nos.chdir('site')\nport = int(os.environ.get('PORT', '8000'))\nwith socketserver.TCPServer(('127.0.0.1', port), http.server.SimpleHTTPRequestHandler) as s:\n    s.serve_forever()\n",
      'site/index.html': '<!doctype html><h1>Brochure from Python</h1>',
    },
    expectHtml: /Brochure from Python/,
    components: [],
  },
];

describe.skipIf(!enabled)('real frameworks, installed from the registry', () => {
  it.each(cases)('$name with $pm', async ({ pm, files, expectHtml, components }) => {
    if (pm !== 'none' && !has(pm)) return console.warn(`skipped: ${pm} is not installed`);
    const dir = scaffold({ ...files, ...lock[pm] });
    const srv = await startServer({ port: 0, token: 'real', workspace: mkdtempSync(join(tmpdir(), 'designer-ws-')) });
    const call = async <T,>(path: string, body?: unknown) =>
      (await (await fetch(`${srv.url}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-designer-token': 'real', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()) as T;
    try {
      const info = await call<{ components: ComponentEntry[] }>('/api/project', { path: dir, setup: true });
      expect(info.components.map((c) => c.name)).toEqual(components);
      let s: SetupState | null = null;
      for (let i = 0; i < 4500 && (!s || s.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 200));
        s = await call<SetupState | null>('/api/project/setup');
      }
      expect(s?.error).toBeUndefined();
      expect(s).toMatchObject({ status: 'done', by: 'claude' });
      expect(s!.tasks.length).toBeGreaterThan(0);
      expect(s!.profile?.summary).toBeTruthy();
      if (pm !== 'none') expect(existsSync(join(dir, 'node_modules'))).toBe(true);
      expect(existsSync(join(dir, '.designer', 'run.json'))).toBe(true);
      const html = await (await fetch(s!.appUrl!)).text();
      expect(html).toMatch(expectHtml);
    } finally {
      srv.close();
    }
  }, 960000);
});
