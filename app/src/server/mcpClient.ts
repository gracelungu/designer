// A small MCP client for local (stdio) servers: newline-delimited JSON-RPC over the child's
// stdin and stdout. Designer uses it to talk to the Azure DevOps MCP server.

import { spawn, type ChildProcess } from 'node:child_process';

export interface McpTool {
  name: string;
  description?: string;
}

export class StdioMcpClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buf = '';
  private stderr = '';
  private ready?: Promise<void>;
  tools: McpTool[] = [];

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ) {}

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start() {
    if (this.ready && this.running) return this.ready;
    this.ready = (async () => {
      const child = spawn(this.command, this.args, { cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => this.onData(d));
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
      const failAll = (why: string) => {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.fail(new Error(why));
          this.pending.delete(id);
        }
      };
      child.on('error', (e) => failAll(`Could not start ${this.command}: ${e.message}`));
      child.on('exit', (code) => failAll(`The MCP server stopped (exit ${code}).${this.stderr.trim() ? ` ${lastLine(this.stderr)}` : ''}`));
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'designer', version: '0.2.0' } });
      this.notify('notifications/initialized');
      const list = (await this.request('tools/list', {})) as { tools?: McpTool[] };
      this.tools = list.tools ?? [];
    })();
    this.ready.catch(() => this.stop());
    return this.ready;
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Servers sometimes log to stdout; skip anything that isn't JSON.
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new Error(msg.error.message ?? 'MCP error'));
      else p.done(msg.result);
    }
  }

  private send(m: unknown) {
    this.child?.stdin?.write(JSON.stringify(m) + '\n');
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} timed out.${this.stderr.trim() ? ` ${lastLine(this.stderr)}` : ''}`));
      }, this.opts.timeoutMs ?? 60000);
      this.pending.set(id, { done, fail, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Calls a tool and returns its text, parsed as JSON when it is JSON. Tool errors throw. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const r = (await this.request('tools/call', { name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(text || `${name} failed`);
    if (r.structuredContent !== undefined) return r.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** The first tool whose name matches one of the patterns, in order. */
  find(...patterns: RegExp[]): string | undefined {
    for (const p of patterns) {
      const t = this.tools.find((x) => p.test(x.name));
      if (t) return t.name;
    }
    return undefined;
  }

  stop() {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}

const lastLine = (s: string) => s.trim().split('\n').pop()!.slice(0, 300);
