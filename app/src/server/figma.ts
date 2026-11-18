/**
 * A small client for the Figma desktop app's local MCP server (Dev Mode MCP server), so Designer can
 * detect it, list what is selected or on the current page, and show thumbnails before Claude imports.
 * It speaks streamable HTTP MCP: JSON-RPC over POST, replies as JSON or as server-sent events.
 */

export const FIGMA_DEFAULT_URLS = ['http://127.0.0.1:3845/mcp', 'http://localhost:3845/mcp'];

export interface FigmaFrame {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  children?: number;
}

export interface FigmaStatus {
  state: 'connected' | 'not-running' | 'error';
  url: string;
  detail?: string;
  server?: string;
  tools?: string[];
  /** What is selected in Figma right now (top-level nodes of the selection). */
  selection?: FigmaFrame[];
  /** Top-level frames of the current page, when nothing is selected or the server lists them. */
  page?: FigmaFrame[];
  pageName?: string;
}

type ToolResult = { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

export class FigmaClient {
  private session?: string;
  private nextId = 1;
  tools: string[] = [];
  server = '';

  constructor(
    readonly url: string,
    private timeout = 4000,
  ) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const id = notify ? undefined : this.nextId++;
    const r = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(this.timeout),
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return undefined;
    if (!r.ok) throw new Error(`Figma MCP answered ${r.status}`);
    const text = await r.text();
    const msg = parseReply(text, r.headers.get('content-type') ?? '', id!);
    if (msg.error) throw new Error(msg.error.message ?? 'Figma MCP error');
    return msg.result;
  }

  async connect() {
    const init = (await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'designer', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };
    this.server = [init?.serverInfo?.name, init?.serverInfo?.version].filter(Boolean).join(' ');
    await this.rpc('notifications/initialized', undefined, true).catch(() => undefined);
    const list = (await this.rpc('tools/list', {})) as { tools?: { name: string }[] };
    this.tools = (list?.tools ?? []).map((t) => t.name);
  }

  has(name: string) {
    return this.tools.includes(name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await this.rpc('tools/call', { name, arguments: args })) as ToolResult;
  }

  /** The XML outline of the selection (no nodeId) or of one node. */
  async metadata(nodeId?: string): Promise<string> {
    const tool = this.has('get_metadata') ? 'get_metadata' : undefined;
    if (!tool) return '';
    const r = await this.call(tool, { ...(nodeId ? { nodeId } : {}), clientLanguages: 'typescript', clientFrameworks: 'react' });
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(text || 'get_metadata failed');
    return text;
  }

  /** A PNG/JPEG thumbnail of one node, as a data URL. */
  async screenshot(nodeId: string): Promise<string | null> {
    const tool = ['get_screenshot', 'get_image'].find((t) => this.has(t));
    if (!tool) return null;
    const r = await this.call(tool, { nodeId, clientLanguages: 'typescript', clientFrameworks: 'react' });
    const img = (r.content ?? []).find((c) => c.type === 'image' && c.data);
    return img ? `data:${img.mimeType ?? 'image/png'};base64,${img.data}` : null;
  }
}

function parseReply(text: string, type: string, id: number): { result?: unknown; error?: { message?: string } } {
  if (type.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    const msgs = text
      .split(/\n\n+/)
      .map((block) =>
        block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n'),
      )
      .filter(Boolean)
      .map((d) => {
        try {
          return JSON.parse(d) as { id?: number; result?: unknown; error?: { message?: string } };
        } catch {
          return null;
        }
      })
      .filter((m): m is { id?: number; result?: unknown; error?: { message?: string } } => !!m);
    return msgs.find((m) => m.id === id) ?? msgs[msgs.length - 1] ?? {};
  }
  return JSON.parse(text) as { result?: unknown; error?: { message?: string } };
}

const ATTR = /([\w-]+)="([^"]*)"/g;

function attrs(tag: string) {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR)) out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
}

/**
 * Reads the top-level nodes out of get_metadata's XML outline, e.g.
 * `<frame id="1:2" name="Home" x="0" y="0" width="1440" height="900">…</frame>`.
 * A `<canvas>` / `<page>` wrapper is unwrapped, and its name is returned as the page name.
 */
export function parseOutline(xml: string): { pageName?: string; nodes: FigmaFrame[] } {
  const tags = [...xml.matchAll(/<(\/?)([\w-]+)([^>]*?)(\/?)>/g)];
  const nodes: FigmaFrame[] = [];
  let depth = 0;
  let base = 0;
  let pageName: string | undefined;
  const stack: FigmaFrame[] = [];
  for (const [, close, name, rest, self] of tags) {
    if (close) {
      depth--;
      stack.pop();
      continue;
    }
    const a = attrs(rest);
    const type = name.toLowerCase();
    if (depth === 0 && (type === 'canvas' || type === 'page' || type === 'document')) {
      pageName = a.name;
      base = 1;
      if (!self) {
        depth++;
        stack.push({ id: a.id ?? '', name: a.name ?? '', type });
      }
      continue;
    }
    const node: FigmaFrame = {
      id: a.id ?? '',
      name: a.name ?? type,
      type,
      width: a.width ? Math.round(Number(a.width)) : undefined,
      height: a.height ? Math.round(Number(a.height)) : undefined,
      children: 0,
    };
    if (depth === base && node.id) nodes.push(node);
    else if (depth === base + 1 && stack[stack.length - 1]?.children !== undefined) stack[stack.length - 1].children! += 1;
    if (!self) {
      depth++;
      stack.push(node);
    }
  }
  return { pageName, nodes };
}

/** Finds the Figma desktop MCP server and reads what is selected (or on the page) right now. */
export async function figmaStatus(urls: string[] = FIGMA_DEFAULT_URLS): Promise<{ status: FigmaStatus; client?: FigmaClient }> {
  let lastErr = '';
  for (const url of urls) {
    const client = new FigmaClient(url);
    try {
      await client.connect();
    } catch (e) {
      lastErr = (e as Error).message;
      continue;
    }
    const status: FigmaStatus = { state: 'connected', url, server: client.server, tools: client.tools };
    try {
      const outline = parseOutline(await client.metadata());
      status.selection = outline.nodes;
      status.pageName = outline.pageName;
    } catch (e) {
      status.detail = (e as Error).message;
      status.selection = [];
    }
    return { status, client };
  }
  const refused = /fetch failed|ECONNREFUSED|timeout|aborted/i.test(lastErr) || !lastErr;
  return { status: { state: refused ? 'not-running' : 'error', url: urls[0], detail: lastErr || undefined } };
}
