import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/server/claudeCli';
import { ClaudeSession, summarizeTool } from '../src/server/session';
import type { ServerMessage } from '../src/shared/protocol';

const fake = join(__dirname, 'fixtures', 'fake-claude.mjs');

describe('buildArgs', () => {
  it('asks the CLI for headless stream-json with stdio permission prompts', () => {
    const a = buildArgs({ model: 'opus', effort: 'high', permissionMode: 'plan', resume: 'abc' });
    expect(a).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--replay-user-messages']));
    expect(a.join(' ')).toContain('--model opus --effort high --permission-mode plan --resume abc');
  });
  it('leaves the mode to Claude Code by default', () => {
    expect(buildArgs({ permissionMode: 'default' })).not.toContain('--permission-mode');
  });
});

describe('summarizeTool', () => {
  it('describes steps in plain words', () => {
    expect(summarizeTool('Edit', { file_path: '/repo/src/a.tsx' }, '/repo')).toBe('Edit src/a.tsx');
    expect(summarizeTool('Bash', { command: 'npm test' }, '/repo')).toBe('Run `npm test`');
    expect(summarizeTool('mcp__figma__get_code', {}, '/repo')).toBe('figma: get_code');
  });
});

describe('ClaudeSession over the CLI protocol', () => {
  it('streams a turn, asks permission, snapshots before/after, and rewinds', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-')));
    writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
    const msgs: ServerMessage[] = [];
    let session!: ClaudeSession;
    const done = new Promise<void>((resolve) => {
      session = new ClaudeSession(dir, fake, (m) => {
        msgs.push(m);
        if (m.type === 'item' && m.item.kind === 'permission' && m.item.state === 'pending') session.answerPermission(m.item.requestId, true);
        if (m.type === 'item' && m.item.kind === 'result') resolve();
      });
    });
    await session.start({ model: 'default' });
    const caps = await session.capabilities();
    expect(caps.claudeVersion).toBe('9.9.9');
    expect(caps.models[0].supportedEffortLevels).toEqual(['low', 'high']);
    expect(caps.commands.map((c) => c.name)).toEqual(['review', 'my-skill']);
    expect(caps.mcpServers[0]).toMatchObject({ name: 'figma', status: 'connected', toolCount: 1 });

    session.prompt('goodbye');
    await done;
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('goodbye world\n');
    const change = msgs.find((m) => m.type === 'file-change');
    expect(change).toMatchObject({ change: { path: 'hello.txt', before: 'hello world\n', after: 'goodbye world\n' } });
    expect(msgs.some((m) => m.type === 'delta' && m.text === 'Editing ')).toBe(true);
    expect(msgs.some((m) => m.type === 'item' && m.item.kind === 'user' && m.item.userMessageId === 'u-1')).toBe(true);
    expect(msgs.some((m) => m.type === 'session' && m.sessionId === 'sess-1')).toBe(true);

    await session.rewind('u-1');
    expect(msgs.find((m) => m.type === 'rewound')).toMatchObject({ result: { canRewind: true, filesChanged: ['hello.txt'] } });
    session.stop();
  });

  it('keeps the file untouched when the designer denies the edit', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-')));
    writeFileSync(join(dir, 'hello.txt'), 'hello world\n');
    let session!: ClaudeSession;
    const done = new Promise<void>((resolve) => {
      session = new ClaudeSession(dir, fake, (m) => {
        if (m.type === 'item' && m.item.kind === 'permission' && m.item.state === 'pending') session.answerPermission(m.item.requestId, false);
        if (m.type === 'item' && m.item.kind === 'result') resolve();
      });
    });
    await session.start({});
    session.prompt('goodbye');
    await done;
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello world\n');
    session.stop();
  });
});
