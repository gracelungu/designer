import { describe, expect, it } from 'vitest';
import { candidatePaths, modeOptions, parsePermissionModes } from '../src/server/claude';
import { isLoopbackHost } from '../src/server/index';
import { findLocalUrl, parseGitStatus, parseStoriesFile, storyNameFromExport } from '../src/server/project';
import { projectDirName, summarize } from '../src/server/transcripts';
import { collapse, lineDiff } from '../src/web/diff';
import { chatReducer, initialChat, upsert } from '../src/web/store';

describe('Claude Code discovery', () => {
  it('reads permission modes from claude --help', () => {
    const help = '  --permission-mode <mode>   Permission mode\n      (choices: "acceptEdits", "auto",\n      "bypassPermissions", "manual",\n      "dontAsk", "plan")\n  --effort <level>';
    expect(parsePermissionModes(help)).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    expect(modeOptions(parsePermissionModes(help)).map((m) => m.value)).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(modeOptions(['brandNew'])[0]).toMatchObject({ value: 'brandNew', label: 'brandNew' });
  });
  it('looks in PATH and the usual install folders', () => {
    const paths = candidatePaths({ PATH: '/x/bin' }, '/home/me');
    expect(paths[0]).toBe('/x/bin/claude');
    expect(paths).toContain('/home/me/.local/bin/claude');
  });
  it('only answers loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1:4818')).toBe(true);
    expect(isLoopbackHost('localhost:5173')).toBe(true);
    expect(isLoopbackHost('evil.example:4818')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('sessions on disk', () => {
  it('names project folders the way Claude Code does', () => {
    expect(projectDirName('/Users/me/dev/my.app')).toBe('-Users-me-dev-my-app');
  });
  it('titles a session by custom title, summary, or first prompt', () => {
    expect(summarize([{ type: 'user', message: { content: 'Make cards denser' }, gitBranch: 'main' }])).toEqual({ title: 'Make cards denser', gitBranch: 'main' });
    expect(summarize([{ type: 'summary', summary: 'Card work' }, { type: 'custom-title', customTitle: 'Pricing' }]).title).toBe('Pricing');
  });
});

describe('git', () => {
  it('parses porcelain v2 status', () => {
    const out = '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n1 .M N... 100644 100644 100644 a b src/App.tsx\n? new.txt\n';
    expect(parseGitStatus(out)).toEqual({ branch: 'main', ahead: 2, behind: 3, changed: [{ path: 'src/App.tsx', status: 'M' }, { path: 'new.txt', status: '?' }] });
  });
});

describe('dev servers', () => {
  it('finds the URL a dev server prints', () => {
    expect(findLocalUrl('Serving HTTP on 127.0.0.1 port 5199 (http://127.0.0.1:5199/) ...')).toBe('http://127.0.0.1:5199');
    expect(findLocalUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173');
    expect(findLocalUrl('Storybook started at http://localhost:6006/.')).toBe('http://localhost:6006');
    expect(findLocalUrl('nothing here')).toBeUndefined();
  });
});

describe('stories', () => {
  it('reads CSF titles and story ids', () => {
    const src = "export default { title: 'UI/Button', component: Button };\nexport const Primary = {};\nexport const LargeSecondary: Story = {};";
    const e = parseStoriesFile(src, 'src/Button.stories.tsx');
    expect(e.title).toBe('UI/Button');
    expect(e.stories.map((s) => s.id)).toEqual(['ui-button--primary', 'ui-button--large-secondary']);
  });
  it('falls back to the file path for the title', () => {
    expect(parseStoriesFile('export const A = {}', 'src/components/Card.stories.tsx').title).toBe('components/Card');
    expect(storyNameFromExport('WithIconLeft')).toBe('With Icon Left');
  });
});

describe('diff', () => {
  it('finds added and removed lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(d.map((l) => l.type)).toEqual(['same', 'del', 'add', 'same', 'add']);
  });
  it('collapses long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'X');
    const c = collapse(lineDiff(before, after), 1);
    expect(c.filter((x) => x.type === 'gap')).toHaveLength(2);
  });
});

describe('chat store', () => {
  it('merges tool results into the running step', () => {
    let items = upsert([], { kind: 'tool', id: 't', name: 'Edit', summary: 'Edit a.tsx', input: {}, status: 'running' });
    items = upsert(items, { kind: 'tool', id: 't', name: '', summary: '', input: undefined, status: 'done', output: 'ok' });
    expect(items[0]).toMatchObject({ name: 'Edit', summary: 'Edit a.tsx', status: 'done', output: 'ok' });
  });
  it('appends streamed text', () => {
    let s = chatReducer(initialChat, { type: 'item', item: { kind: 'assistant', id: 'a', text: '', streaming: true } });
    s = chatReducer(s, { type: 'delta', id: 'a', text: 'Hi' });
    s = chatReducer(s, { type: 'delta', id: 'a', text: ' there' });
    expect(s.items[0]).toMatchObject({ text: 'Hi there' });
  });
});
