import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ClaudeCli, type CliMessage } from './claudeCli.js';
import { sessionEntries } from './transcripts.js';
import type { Attachment, Capabilities, ChatItem, PermissionMode, ServerMessage } from '../shared/protocol.js';

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** One-line, human-readable description of a tool call for the Chat tab. */
export function summarizeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => (typeof p === 'string' ? (isAbsolute(p) ? relative(cwd, p) || p : p) : '');
  switch (name) {
    case 'Read':
      return `Read ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${rel(input.file_path)}`;
    case 'Write':
      return `Write ${rel(input.file_path)}`;
    case 'NotebookEdit':
      return `Edit notebook ${rel(input.notebook_path)}`;
    case 'Bash':
      return `Run \`${String(input.command ?? '').slice(0, 120)}\``;
    case 'Glob':
      return `Find files ${String(input.pattern ?? '')}`;
    case 'Grep':
      return `Search for "${String(input.pattern ?? '')}"`;
    case 'WebFetch':
      return `Open ${String(input.url ?? '')}`;
    case 'WebSearch':
      return `Search the web for "${String(input.query ?? '')}"`;
    case 'TodoWrite':
      return 'Update the plan';
    case 'Agent':
    case 'Task':
      return `Start a helper: ${String(input.description ?? '')}`;
    case 'Skill':
      return `Use skill ${String(input.skill ?? input.command ?? '')}`;
    case 'ExitPlanMode':
      return 'Plan ready for approval';
    case 'mcp__designer__open_project':
      return `Open the project ${String(input.path ?? '')}`;
    case 'mcp__designer__run_project':
      return `${input.kind === 'storybook' ? 'Start Storybook' : 'Run the project'} with \`${String(input.command ?? '')}\``;
    case 'mcp__designer__get_canvas':
      return 'Look at the canvas';
    case 'mcp__designer__add_to_canvas': {
      const count = Array.isArray(input.nodes) ? input.nodes.length : 0;
      return `Add ${count === 1 ? 'a layer' : `${count} layers`} to the canvas`;
    }
    case 'mcp__designer__update_layers': {
      const count = Array.isArray(input.updates) ? input.updates.length : 0;
      return `Change ${count === 1 ? 'a layer' : `${count} layers`} on the canvas`;
    }
    case 'mcp__designer__show_component':
      return `Show ${String(input.storyId ?? 'a component')} on the canvas`;
    default:
      if (name.startsWith('mcp__figma')) return `Read Figma (${name.split('__').slice(2).join('__').replace(/_/g, ' ')})`;
      return name.startsWith('mcp__') ? `${name.split('__')[1]}: ${name.split('__').slice(2).join('__').replace(/_/g, ' ')}` : name;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b: { type?: string; text?: string }) => (b && b.type === 'text' ? (b.text ?? '') : ''))
      .join('');
  return '';
}


/** Removes Designer's own lead lines ("[Designer] ...") from a message as Claude saw it. */
export function stripNotes(text: string) {
  return text.replace(/^(\[Designer\][^\n]*\n)+\n?/, '').trim();
}

type Decision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface StartOptions {
  resume?: string;
  model?: string;
  effort?: string;
  mode?: PermissionMode;
}

/** One chat with the local Claude Code, translated into Designer's chat items. */
export class ClaudeSession {
  private cli?: ClaudeCli;
  private pendingPermissions = new Map<string, (r: Decision) => void>();
  private beforeSnapshots = new Map<string, { path: string; content: string; tool: string }>();
  private pendingUserIds: string[] = [];
  private streamMsgId = '';
  private stderrTail = '';
  sessionId?: string;
  model?: string;
  effort?: string;
  mode: PermissionMode = 'default';
  busy = false;

  /** MCP servers this session adds to the user's own (Designer's tools, the Figma desktop server). */
  private servers: Record<string, Record<string, unknown>> = {};
  /** Said to Claude at the start of the next message, e.g. that the user opened a project. */
  private notes: string[] = [];

  constructor(
    readonly cwd: string,
    private readonly claudePath: string,
    private readonly send: (m: ServerMessage) => void,
    private readonly extras: {
      systemPrompt?: string;
      servers?: Record<string, Record<string, unknown>>;
      allowedTools?: string[];
      /** The designer asked for something (a visual review starts). */
      onTurnStart?: (text: string) => void;
      /** Claude is about to edit this file; the edit waits for it (up to 25 s), e.g. for before screenshots. */
      onEditStart?: (absPath: string) => Promise<void>;
      /** Claude's turn is over. */
      onTurnEnd?: () => void;
    } = {},
  ) {
    this.servers = { ...(extras.servers ?? {}) };
  }

  note(text: string) {
    this.notes.push(text);
  }

  private async applyServers() {
    if (!this.cli || !Object.keys(this.servers).length) return;
    const r = (await this.cli.request({ subtype: 'mcp_set_servers', servers: this.servers }).catch((e: Error) => ({ errors: { designer: e.message } }))) as { errors?: Record<string, string> };
    if (r.errors && Object.keys(r.errors).length) this.send({ type: 'item', item: { kind: 'system', id: randomUUID(), text: `Some tools could not connect: ${Object.entries(r.errors).map(([k, v]) => `${k} (${v})`).join(', ')}` } });
  }

  get running() {
    return !!this.cli && !this.cli.closed;
  }

  status() {
    this.send({ type: 'session', sessionId: this.sessionId, model: this.model, effort: this.effort, mode: this.mode, running: this.running, busy: this.busy });
  }

  async start(opts: StartOptions) {
    this.stop();
    this.model = opts.model;
    this.effort = opts.effort;
    this.mode = opts.mode ?? 'default';
    this.sessionId = opts.resume;
    if (opts.resume) await this.sendHistory(opts.resume);
    const cli: ClaudeCli = new ClaudeCli({
      claudePath: this.claudePath,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      permissionMode: this.mode,
      resume: opts.resume,
      appendSystemPrompt: this.extras.systemPrompt,
      allowedTools: this.extras.allowedTools,
      hooks: {
        PreToolUse: [{ matcher: EDIT_TOOLS.join('|'), id: 'before-edit' }],
        PostToolUse: [{ matcher: EDIT_TOOLS.join('|'), id: 'after-edit' }],
      },
      onMessage: (m) => {
        if (cli === this.cli) this.handle(m);
      },
      onPermission: (req, signal) => this.askPermission(req.toolName, req.input, signal),
      onHook: (id, input, toolUseId) => this.onHook(id, input, toolUseId),
      onExit: (code, stderr) => {
        if (cli !== this.cli) return;
        this.stderrTail = stderr;
        if (code) this.send({ type: 'item', item: { kind: 'error', id: randomUUID(), text: `Claude Code stopped (exit ${code}).\n${stderr.trim().split('\n').slice(-4).join('\n')}` } });
        this.cli = undefined;
        this.busy = false;
        this.status();
      },
    });
    this.cli = cli;
    this.status();
    await cli.ready;
    await this.applyServers();
  }

  private async onHook(id: string, input: Record<string, unknown>, toolUseId?: string) {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const p = (toolInput.file_path ?? toolInput.notebook_path) as string | undefined;
    if (id === 'before-edit' && toolUseId && p) {
      const abs = resolve(this.cwd, p);
      this.beforeSnapshots.set(toolUseId, { path: abs, content: await readFile(abs, 'utf8').catch(() => ''), tool: String(input.tool_name ?? 'Edit') });
      if (this.extras.onEditStart) {
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.extras.onEditStart(abs).catch(() => undefined), new Promise((r) => (t = setTimeout(r, 25000)))]);
        clearTimeout(t);
      }
    }
    if (id === 'after-edit' && toolUseId) {
      const snap = this.beforeSnapshots.get(toolUseId);
      if (snap) {
        this.beforeSnapshots.delete(toolUseId);
        const after = await readFile(snap.path, 'utf8').catch(() => '');
        this.send({ type: 'file-change', change: { toolUseId, tool: snap.tool, path: relative(this.cwd, snap.path), before: snap.content, after } });
      }
    }
    return { continue: true };
  }

  private async sendHistory(sessionId: string) {
    try {
      const entries = await sessionEntries(this.cwd, sessionId);
      const items: ChatItem[] = [];
      for (const e of entries) {
        if (e.isSidechain || !e.uuid || !e.message) continue;
        if (e.type === 'user') {
          const text = stripNotes(textOf(e.message.content));
          if (text && !text.startsWith('<')) items.push({ kind: 'user', id: e.uuid, text, userMessageId: e.uuid });
        } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
          (e.message.content as { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }[]).forEach((b, i) => {
            if (b.type === 'text' && b.text) items.push({ kind: 'assistant', id: `${e.uuid}:${i}`, text: b.text });
            if (b.type === 'tool_use') items.push({ kind: 'tool', id: b.id ?? `${e.uuid}:${i}`, name: b.name ?? '', summary: summarizeTool(b.name ?? '', b.input ?? {}, this.cwd), input: b.input, status: 'done' });
          });
        }
      }
      this.send({ type: 'history', items });
    } catch (e) {
      this.send({ type: 'error', text: `Could not load that session: ${(e as Error).message}` });
    }
  }

  private askPermission(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Decision> {
    if (tool === 'AskUserQuestion') {
      return Promise.resolve({ behavior: 'deny', message: 'Designer cannot show multiple-choice questions yet. Ask the question as plain text in your reply instead.' });
    }
    const requestId = randomUUID();
    const summary = tool === 'ExitPlanMode' ? 'Approve this plan?' : summarizeTool(tool, input, this.cwd);
    return new Promise((done) => {
      this.pendingPermissions.set(requestId, done);
      this.send({ type: 'item', item: { kind: 'permission', id: requestId, requestId, tool, summary, input, state: 'pending' } });
      signal.addEventListener('abort', () => {
        if (this.pendingPermissions.delete(requestId)) done({ behavior: 'deny', message: 'Cancelled' });
      });
    });
  }

  answerPermission(requestId: string, allow: boolean, message?: string) {
    const done = this.pendingPermissions.get(requestId);
    if (!done) return;
    this.pendingPermissions.delete(requestId);
    this.send({ type: 'item', item: { kind: 'permission', id: requestId, requestId, tool: '', summary: '', input: undefined, state: allow ? 'allowed' : 'denied' } });
    done(allow ? { behavior: 'allow' } : { behavior: 'deny', message: message || 'The designer declined this step.' });
  }

  /** Sends the user's message. `context` (what's selected on the canvas, say) goes to Claude but shows as a chip. */
  prompt(text: string, attachments: Attachment[] = [], context?: string) {
    if (!this.cli) throw new Error('No session running');
    const id = randomUUID();
    this.pendingUserIds.push(id);
    this.send({
      type: 'item',
      item: { kind: 'user', id, text, context, attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, preview: a.mediaType.startsWith('image/') ? `data:${a.mediaType};base64,${a.data}` : undefined })) },
    });
    this.busy = true;
    this.status();
    if (!text.startsWith('/')) this.extras.onTurnStart?.(text);
    const notes = this.notes.splice(0);
    const lead = [...notes.map((n) => `[Designer] ${n}`), context ? `[Designer] ${context}` : ''].filter(Boolean).join('\n');
    const full = lead && !text.startsWith('/') ? `${lead}\n\n${text}` : text;
    if (!attachments.length) {
      this.cli.sendUser(full);
      return;
    }
    const blocks: Record<string, unknown>[] = [];
    for (const a of attachments) {
      if (a.mediaType.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
      else blocks.push({ type: 'text', text: `<file name="${a.name}">\n${a.data}\n</file>` });
    }
    blocks.push({ type: 'text', text: full });
    this.cli.sendUser(blocks);
  }

  private need() {
    if (!this.cli) throw new Error('No session running');
    return this.cli;
  }

  async interrupt() {
    await this.cli?.request({ subtype: 'interrupt' });
  }

  async setModel(model: string) {
    await this.need().request({ subtype: 'set_model', model });
    this.model = model;
    this.status();
  }

  async setMode(mode: PermissionMode) {
    await this.need().request({ subtype: 'set_permission_mode', mode });
    this.mode = mode;
    this.status();
  }

  /** Adds (or replaces) an MCP server for this session, now if Claude Code is running, else at start. */
  async addServer(name: string, config: Record<string, unknown>) {
    if (JSON.stringify(this.servers[name]) === JSON.stringify(config)) return;
    this.servers[name] = config;
    if (!this.cli) return;
    await this.cli.request({ subtype: 'mcp_set_servers', servers: this.servers });
  }

  async connectFigma(url: string) {
    this.servers.figma = { type: 'http', url };
    const r = (await this.need().request({ subtype: 'mcp_set_servers', servers: this.servers })) as { errors?: Record<string, string> };
    const ok = !r.errors || Object.keys(r.errors).length === 0;
    this.send({ type: 'item', item: { kind: 'system', id: randomUUID(), text: ok ? 'Figma desktop MCP server connected to this Claude session.' : `Figma MCP: ${JSON.stringify(r.errors)}` } });
  }

  async rewind(userMessageId: string, dryRun = false) {
    const result = (await this.need().request({ subtype: 'rewind_files', user_message_id: userMessageId, dry_run: dryRun })) as {
      canRewind: boolean;
      error?: string;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
    };
    this.send({ type: 'rewound', userMessageId, dryRun, result });
  }

  /** Everything the menus show, straight from this Claude Code process. */
  async capabilities(): Promise<Omit<Capabilities, 'modes'>> {
    const cli = this.need();
    type Init = {
      commands: { name: string; description: string; argumentHint?: string; builtin?: boolean }[];
      agents: { name: string; description?: string }[];
      models: { value: string; displayName: string; description: string; supportedEffortLevels?: string[]; supportsAutoMode?: boolean; supportsFastMode?: boolean }[];
      account: Record<string, unknown>;
      output_style: string;
      available_output_styles: string[];
      claude_code_version?: string;
      fast_mode_state?: string;
    };
    const init = (await cli.ready) as unknown as Init;
    const mcp = ((await cli.request({ subtype: 'mcp_status' }).catch(() => ({ mcpServers: [] }))) as { mcpServers: { name: string; status: string; scope?: string; error?: string; tools?: unknown[] }[] }).mcpServers;
    return {
      claudeVersion: init.claude_code_version,
      models: init.models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
        supportedEffortLevels: m.supportedEffortLevels ?? [],
        supportsAutoMode: !!m.supportsAutoMode,
        supportsFastMode: !!m.supportsFastMode,
      })),
      commands: init.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint ?? '', builtin: !!c.builtin })),
      agents: init.agents.map((a) => ({ name: a.name, description: a.description })),
      outputStyles: init.available_output_styles ?? [],
      outputStyle: init.output_style,
      account: init.account ?? {},
      mcpServers: mcp.map((s) => ({ name: s.name, status: s.status, scope: s.scope, error: s.error, toolCount: s.tools?.length ?? 0 })),
      fastMode: init.fast_mode_state,
    };
  }

  stop() {
    for (const id of [...this.pendingPermissions.keys()]) this.answerPermission(id, false, 'Session closed');
    const cli = this.cli;
    this.cli = undefined;
    cli?.close();
    this.busy = false;
    this.pendingUserIds = [];
  }

  handle(m: CliMessage) {
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id as string;
      if (!this.model) this.model = m.model as string;
      if (m.permissionMode) this.mode = m.permissionMode as PermissionMode;
      this.status();
      return;
    }
    if (m.type === 'stream_event') {
      const ev = m.event as { type: string; index?: number; message?: { id: string }; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } };
      if (m.parent_tool_use_id) return;
      if (ev.type === 'message_start' && ev.message) this.streamMsgId = ev.message.id;
      const id = `${this.streamMsgId}:${ev.index}`;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') this.send({ type: 'item', item: { kind: 'assistant', id, text: '', streaming: true } });
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') this.send({ type: 'item', item: { kind: 'thinking', id, text: '' } });
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.send({ type: 'delta', id, text: ev.delta.text ?? '' });
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') this.send({ type: 'delta', id, text: ev.delta.thinking ?? '' });
      return;
    }
    if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return;
      const message = m.message as { id: string; content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] };
      message.content.forEach((b, i) => {
        const id = `${message.id}:${i}`;
        if (b.type === 'text') this.send({ type: 'item', item: { kind: 'assistant', id, text: b.text ?? '' } });
        if (b.type === 'tool_use' && b.id)
          this.send({ type: 'item', item: { kind: 'tool', id: b.id, name: b.name ?? '', summary: summarizeTool(b.name ?? '', b.input ?? {}, this.cwd), input: b.input, status: 'running' } });
      });
      return;
    }
    if (m.type === 'user') {
      const message = m.message as { content: unknown };
      if (m.isReplay) {
        const localId = this.pendingUserIds.shift();
        // Text stays as shown; Claude's copy also carries the canvas context.
        if (localId && m.uuid) this.send({ type: 'item', item: { kind: 'user', id: localId, text: '', userMessageId: m.uuid as string } });
        return;
      }
      if (m.parent_tool_use_id || !Array.isArray(message.content)) return;
      for (const b of message.content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        this.send({ type: 'item', item: { kind: 'tool', id: b.tool_use_id, name: '', summary: '', input: undefined, status: b.is_error ? 'error' : 'done', output: textOf(b.content).slice(0, 4000) } });
      }
      return;
    }
    if (m.type === 'result') {
      this.busy = false;
      const ok = m.subtype === 'success' && !m.is_error;
      const text = ok ? '' : String(m.result ?? (m.errors as string[] | undefined)?.join('\n') ?? m.subtype);
      this.send({ type: 'item', item: { kind: 'result', id: (m.uuid as string) ?? randomUUID(), ok, text, costUsd: m.total_cost_usd as number, durationMs: m.duration_ms as number, turns: m.num_turns as number } });
      this.status();
      this.extras.onTurnEnd?.();
      return;
    }
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      this.send({ type: 'item', item: { kind: 'system', id: (m.uuid as string) ?? randomUUID(), text: 'Conversation compacted' } });
    }
  }

  get lastStderr() {
    return this.stderrTail;
  }
}
