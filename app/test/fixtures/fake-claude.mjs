#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks the same stream-json control protocol.
// CI has no signed-in Claude Code, so tests drive this instead.
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }
if (args[0] === '--help') { console.log('  --permission-mode <mode>  Permission mode\n      (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")'); process.exit(0); }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const waiting = new Map();
let n = 0;
const ask = (request) => new Promise((resolve) => { const id = `cli-${n++}`; waiting.set(id, resolve); out({ type: 'control_request', request_id: id, request }); });
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'default';
// Designer's setup run (it asks Claude to get the project running). It follows FAKE_CLAUDE_SETUP, a JSON list
// of { tool, input } steps: Bash runs for real, mcp__<server>__<tool> calls the MCP server Designer gave it.
const isSetup = args.includes('--append-system-prompt') && /get the project running/.test(args[args.indexOf('--append-system-prompt') + 1]);
let servers = {};
async function callMcp(name, input) {
  const [, server, tool] = name.split('__');
  const s = servers[server];
  if (!s) return { text: `No MCP server ${server}`, isError: true };
  const r = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(s.headers ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } }) });
  const j = await r.json();
  return { text: j.result?.content?.[0]?.text ?? JSON.stringify(j), isError: !!j.result?.isError };
}

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
    if (r.subtype === 'mcp_set_servers') servers = r.servers;
    if (r.subtype === 'rewind_files') response = { canRewind: true, filesChanged: ['hello.txt'], insertions: 1, deletions: 1 };
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type === 'user') {
    const full = typeof m.message.content === 'string' ? m.message.content : '';
    // Designer's own notes lead the message ("[Designer] ..."); the fake acts on what the user typed.
    const text = full.replace(/^(\[Designer\][^\n]*\n)+\n?/, '');
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', model, permissionMode: 'default' });
    out({ type: 'user', isReplay: true, uuid: 'u-1', message: m.message, parent_tool_use_id: null });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg1' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Editing ' } } });
    if (process.env.FAKE_CLAUDE_PROMPT_OUT) writeFileSync(process.env.FAKE_CLAUDE_PROMPT_OUT, JSON.stringify({ args, prompt: text }));
    // FAKE_CLAUDE_EDITS: a JSON list of steps, each { file, old, new } (an Edit; a missing file is created
    // with Write) or { tool, input } (any other tool call, e.g. Bash, to check that Designer refuses it).
    // Without it the fake edits hello.txt, replacing "hello" with the prompt.
    if (isSetup) {
      if (process.env.FAKE_CLAUDE_PROMPT_OUT) writeFileSync(process.env.FAKE_CLAUDE_PROMPT_OUT, JSON.stringify({ args, prompt: text }));
      let i = 0;
      for (const step of JSON.parse(process.env.FAKE_CLAUDE_SETUP || '[]')) {
        const id = `setup${++i}`;
        out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg${i}`, content: [{ type: 'text', text: step.say ?? 'Working on it' }, { type: 'tool_use', id, name: step.tool, input: step.input }] } });
        const perm = await ask({ subtype: 'can_use_tool', tool_name: step.tool, input: step.input, tool_use_id: id });
        let result = { text: perm.response?.message ?? 'denied', isError: true };
        if (perm.subtype === 'success' && perm.response.behavior === 'allow') {
          if (step.tool === 'Bash') {
            try {
              result = { text: execSync(step.input.command, { cwd: process.cwd(), encoding: 'utf8' }), isError: false };
            } catch (e) {
              result = { text: String(e.message), isError: true };
            }
          } else if (step.tool.startsWith('mcp__')) result = await callMcp(step.tool, step.input);
          else result = { text: 'ok', isError: false };
        }
        out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result.text, is_error: result.isError }] } });
      }
      const done = process.env.FAKE_CLAUDE_SUMMARY ?? 'It runs.';
      out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg-done', content: [{ type: 'text', text: done }] } });
      out({ type: 'result', subtype: 'success', is_error: false, uuid: 'r1', result: done, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
      return;
    }
    const steps = process.env.FAKE_CLAUDE_EDITS
      ? JSON.parse(process.env.FAKE_CLAUDE_EDITS)
      : [{ file: process.env.FAKE_CLAUDE_FILE || 'hello.txt', old: process.env.FAKE_CLAUDE_FROM || 'hello', new: process.env.FAKE_CLAUDE_FILE ? text.trim().split('\n').pop() : text }];
    // FAKE_CLAUDE_FILE / FAKE_CLAUDE_FROM: edit another file, swapping FROM for the last line of the prompt.
    if (!process.env.FAKE_CLAUDE_EDITS && !process.env.FAKE_CLAUDE_FILE && !existsSync(join(process.cwd(), 'hello.txt'))) writeFileSync(join(process.cwd(), 'hello.txt'), 'hello world\n');
    let i = 0;
    for (const step of steps) {
      const id = `tool${++i}`;
      let tool, input, apply;
      if (step.tool) {
        tool = step.tool;
        input = step.input;
        apply = () => {};
      } else {
        const file = join(process.cwd(), step.file);
        const exists = existsSync(file);
        tool = exists ? 'Edit' : 'Write';
        input = exists ? { file_path: file, old_string: step.old, new_string: step.new } : { file_path: file, content: step.new };
        apply = () => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, exists ? readFileSync(file, 'utf8').replace(step.old, step.new) : step.new);
        };
      }
      out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg${i}`, content: [{ type: 'text', text: 'Editing now' }, { type: 'tool_use', id, name: tool, input }] } });
      const perm = await ask({ subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: id });
      const allowed = perm.subtype === 'success' && perm.response.behavior === 'allow';
      if (allowed) {
        await ask({ subtype: 'hook_callback', callback_id: 'before-edit', input: { tool_name: tool, tool_input: input }, tool_use_id: id });
        apply();
        await ask({ subtype: 'hook_callback', callback_id: 'after-edit', input: { tool_name: tool, tool_input: input }, tool_use_id: id });
      }
      out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: allowed ? 'ok' : (perm.response?.message ?? 'denied'), is_error: !allowed }] } });
    }
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg-done', content: [{ type: 'text', text: process.env.FAKE_CLAUDE_SUMMARY ?? 'Done.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, uuid: 'r1', result: process.env.FAKE_CLAUDE_SUMMARY ?? 'Done.', total_cost_usd: 0.01, duration_ms: 5, num_turns: 1 });
  }
});
