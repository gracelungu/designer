#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks the same stream-json control protocol.
// CI has no signed-in Claude Code, so tests drive this instead.
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }
if (args[0] === '--help') { console.log('  --permission-mode <mode>  Permission mode\n      (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")'); process.exit(0); }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const waiting = new Map();
let n = 0;
const ask = (request) => new Promise((resolve) => { const id = `cli-${n++}`; waiting.set(id, resolve); out({ type: 'control_request', request_id: id, request }); });
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'default';

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_response') { waiting.get(m.response.request_id)?.(m.response); waiting.delete(m.response.request_id); return; }
  if (m.type === 'control_request') {
    const r = m.request;
    let response = {};
    if (r.subtype === 'initialize') response = {
      commands: [{ name: 'review', description: 'Review code', argumentHint: '', builtin: true }, { name: 'my-skill', description: 'A user skill', argumentHint: '<x>' }],
      agents: [{ name: 'Explore' }],
      models: [{ value: 'default', displayName: 'Default', description: 'd', supportedEffortLevels: ['low', 'high'], supportsAutoMode: true }],
      account: { email: 'test@example.com' }, output_style: 'default', available_output_styles: ['default'], claude_code_version: '9.9.9',
    };
    if (r.subtype === 'mcp_status') response = { mcpServers: [{ name: 'figma', status: 'connected', tools: [{ name: 'a' }] }] };
    if (r.subtype === 'rewind_files') response = { canRewind: true, filesChanged: ['hello.txt'], insertions: 1, deletions: 1 };
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type === 'user') {
    const text = typeof m.message.content === 'string' ? m.message.content : '';
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', model, permissionMode: 'default' });
    out({ type: 'user', isReplay: true, uuid: 'u-1', message: m.message, parent_tool_use_id: null });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg1' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Editing ' } } });
    const file = join(process.cwd(), 'hello.txt');
    if (!existsSync(file)) writeFileSync(file, 'hello world\n');
    const input = { file_path: file, old_string: 'hello', new_string: text };
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg1', content: [{ type: 'text', text: 'Editing now' }, { type: 'tool_use', id: 'tool1', name: 'Edit', input }] } });
    const perm = await ask({ subtype: 'can_use_tool', tool_name: 'Edit', input, tool_use_id: 'tool1' });
    if (perm.response.behavior === 'allow') {
      await ask({ subtype: 'hook_callback', callback_id: 'before-edit', input: { tool_name: 'Edit', tool_input: input }, tool_use_id: 'tool1' });
      writeFileSync(file, readFileSync(file, 'utf8').replace('hello', text));
      await ask({ subtype: 'hook_callback', callback_id: 'after-edit', input: { tool_name: 'Edit', tool_input: input }, tool_use_id: 'tool1' });
    }
    out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: perm.response.behavior === 'allow' ? 'ok' : 'denied', is_error: perm.response.behavior !== 'allow' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, uuid: 'r1', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
  }
});
