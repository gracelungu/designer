import { describe, expect, it } from 'vitest';
import { injectProbe, isLoopbackUrl } from '../src/server/proxy';
import { handleMcp, TOOLS, type ToolHost } from '../src/server/mcp';
import { stripNotes, summarizeTool } from '../src/server/session';
import { buildArgs } from '../src/server/claudeCli';

const host = (over: Partial<ToolHost> = {}): ToolHost => ({
  openProject: async (p) => `Opened ${p}`,
  runProject: async (c, k) => `${k}:${c}`,
  canvasState: () => ({ selection: [], layers: [] }),
  addNodes: async (n) => ({ added: n.length }),
  updateNodes: async (u) => ({ updated: u.length }),
  showComponent: async (id) => `Placed ${id}`,
  ...over,
});

describe('preview proxy', () => {
  it('puts the probe first in <head>, once', () => {
    const out = injectProbe('<html><head><title>x</title></head><body></body></html>');
    expect(out).toMatch(/<head><script src="\/__designer_probe\.js"><\/script><title>/);
    expect(injectProbe(out)).toBe(out);
  });
  it('only proxies local dev servers', () => {
    expect(isLoopbackUrl('http://localhost:6006/iframe.html')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.2:3000')).toBe(false);
  });
});

describe('Designer MCP server', () => {
  it('initializes and lists its tools', async () => {
    const init = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, host())) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('designer');
    const list = (await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, host())) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
  it('calls tools and reports errors as tool errors', async () => {
    const ok = (await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_project', arguments: { path: '/x' } } }, host())) as { result: { content: { text: string }[] } };
    expect(ok.result.content[0].text).toBe('Opened /x');
    const bad = (await handleMcp(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'show_component', arguments: { storyId: 'a' } } },
      host({ showComponent: async () => { throw new Error('no storybook'); } }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe('no storybook');
  });
  it('ignores notifications', async () => {
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, host())).toBeNull();
  });
});

describe('session', () => {
  it('hides Designer notes from history', () => {
    expect(stripNotes('[Designer] The user opened x\n[Designer] selection\n\nMake it blue')).toBe('Make it blue');
  });
  it('names Designer tool steps in plain words', () => {
    expect(summarizeTool('mcp__designer__run_project', { command: 'npm run dev', kind: 'app' }, '/')).toBe('Run the project with `npm run dev`');
    expect(summarizeTool('mcp__designer__add_to_canvas', { nodes: [{}, {}] }, '/')).toBe('Add 2 layers to the canvas');
  });
  it('passes the system prompt and auto-allowed tools to Claude Code', () => {
    const args = buildArgs({ appendSystemPrompt: 'hi', allowedTools: ['mcp__designer'] });
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__designer');
  });
});
