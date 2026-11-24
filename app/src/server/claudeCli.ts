// Drives the locally installed `claude` CLI directly: spawns it in headless
// stream-json mode and speaks its stdin/stdout control protocol. No SDK sits in
// between; this is the same process you get from `claude -p` in a terminal.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export type CliMessage = Record<string, unknown> & { type: string; subtype?: string };

export interface CliOptions {
  claudePath: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  resume?: string;
  tools?: string[];
  settingSources?: string;
  /** Added to Claude Code's own system prompt. */
  appendSystemPrompt?: string;
  /** Tools that never ask for permission (e.g. Designer's own MCP tools). */
  allowedTools?: string[];
  /** Hook matchers to register: event -> [{ matcher, id }]. Callbacks arrive through onHook. */
  hooks?: Record<string, { matcher: string; id: string }[]>;
  onMessage: (m: CliMessage) => void;
  onPermission: (req: { toolName: string; input: Record<string, unknown>; toolUseId?: string }, signal: AbortSignal) => Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }>;
  onHook?: (callbackId: string, input: Record<string, unknown>, toolUseId?: string) => Promise<Record<string, unknown>>;
  onExit: (code: number | null, stderr: string) => void;
}

/** Command-line arguments for a headless, stream-json Claude Code session. */
export function buildArgs(o: Pick<CliOptions, 'model' | 'effort' | 'permissionMode' | 'resume' | 'appendSystemPrompt' | 'allowedTools' | 'tools' | 'settingSources'>): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--setting-sources', o.settingSources ?? 'user,project,local',
  ];
  if (o.tools) args.push('--tools', o.tools.join(','), '--strict-mcp-config');
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.permissionMode && o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode);
  if (o.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  if (o.resume) args.push('--resume', o.resume);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
  return args;
}

export class ClaudeCli {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private inflight = new Map<string, AbortController>();
  private stderr = '';
  readonly ready: Promise<Record<string, unknown>>;
  closed = false;

  constructor(private readonly o: CliOptions) {
    this.proc = spawn(o.claudePath, buildArgs(o), {
      cwd: o.cwd,
      // File checkpointing is what makes rewind work for headless sessions.
      env: { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true', CLAUDE_CODE_ENTRYPOINT: 'designer' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
    this.proc.on('error', (e) => this.finish(null, e.message));
    this.proc.on('exit', (code) => this.finish(code, this.stderr));
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));

    const hooks: Record<string, { matcher: string; hookCallbackIds: string[] }[]> = {};
    for (const [event, list] of Object.entries(o.hooks ?? {})) hooks[event] = list.map((h) => ({ matcher: h.matcher, hookCallbackIds: [h.id] }));
    this.ready = this.request({ subtype: 'initialize', hooks });
  }

  private finish(code: number | null, stderr: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(`Claude Code exited${code !== null ? ` with code ${code}` : ''}. ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    this.pending.clear();
    for (const a of this.inflight.values()) a.abort();
    this.o.onExit(code, stderr);
  }

  private write(obj: unknown) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Send a control request (initialize, set_model, interrupt, rewind_files, ...) and wait for its answer. */
  request(request: Record<string, unknown>, timeoutMs = 60000): Promise<Record<string, unknown>> {
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`Claude Code did not answer ${String(request.subtype)} in time`));
      }, timeoutMs);
      this.pending.set(request_id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.write({ type: 'control_request', request_id, request });
    });
  }

  /** Sends a user turn: plain text, or content blocks (text plus images). */
  sendUser(content: string | Record<string, unknown>[]) {
    this.write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } });
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let m: CliMessage;
    try {
      m = JSON.parse(line) as CliMessage;
    } catch {
      return;
    }
    if (m.type === 'control_response') {
      const r = m.response as { subtype: string; request_id: string; response?: Record<string, unknown>; error?: string };
      const p = this.pending.get(r.request_id);
      if (!p) return;
      this.pending.delete(r.request_id);
      if (r.subtype === 'success') p.resolve(r.response ?? {});
      else p.reject(new Error(r.error ?? 'Claude Code returned an error'));
      return;
    }
    if (m.type === 'control_request') {
      void this.answer(m.request_id as string, m.request as Record<string, unknown>);
      return;
    }
    if (m.type === 'control_cancel_request') {
      this.inflight.get(m.request_id as string)?.abort();
      return;
    }
    this.o.onMessage(m);
  }

  private async answer(requestId: string, req: Record<string, unknown>) {
    const abort = new AbortController();
    this.inflight.set(requestId, abort);
    try {
      let response: Record<string, unknown> = {};
      if (req.subtype === 'can_use_tool') {
        const decision = await this.o.onPermission(
          { toolName: req.tool_name as string, input: (req.input ?? {}) as Record<string, unknown>, toolUseId: req.tool_use_id as string | undefined },
          abort.signal,
        );
        response = decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: decision.updatedInput ?? req.input, toolUseID: req.tool_use_id } : { ...decision, toolUseID: req.tool_use_id };
      } else if (req.subtype === 'hook_callback' && this.o.onHook) {
        response = await this.o.onHook(req.callback_id as string, (req.input ?? {}) as Record<string, unknown>, req.tool_use_id as string | undefined);
      } else {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Designer does not handle ${String(req.subtype)}` } });
        return;
      }
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    } catch (e) {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: (e as Error).message } });
    } finally {
      this.inflight.delete(requestId);
    }
  }

  close() {
    if (this.closed) return;
    this.proc.stdin.end();
    this.proc.kill();
  }
}
