import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { detectClaude, permissionModes } from './claude.js';
import { ClaudeSession } from './session.js';
import { listSessions } from './transcripts.js';
import { findTokens, updateToken } from './tokens.js';
import { DevProcess, diffFor, getLatest, listDir, projectInfo, readMemory, saveVersion, shareForReview, writeMemory } from './project.js';
import type { Capabilities, ClaudeInstall, ClientMessage, ServerMessage } from '../shared/protocol.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  initialProject?: string;
  /** Fixed token, for the Vite dev setup only. */
  token?: string;
}

/** Only answer requests addressed to loopback, which blocks DNS-rebinding pages. */
export function isLoopbackHost(hostHeader: string | undefined) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader ?? '');
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

export async function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(24).toString('hex');
  let claude: ClaudeInstall = await detectClaude();
  let projectPath: string | undefined = opts.initialProject;
  let session: ClaudeSession | undefined;
  let capsCache: Capabilities | undefined;
  const sockets = new Set<WebSocket>();
  const app = new DevProcess('dev');
  const storybook = new DevProcess('storybook');

  const broadcast = (m: ServerMessage) => {
    const data = JSON.stringify(m);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  };

  function requireProject() {
    if (!projectPath) throw new HttpError(400, 'Open a project folder first.');
    return projectPath;
  }

  function ensureSession() {
    const cwd = requireProject();
    if (!claude.found || !claude.path) throw new HttpError(400, claude.error ?? 'Claude Code not found');
    if (!session || session.cwd !== cwd) {
      session?.stop();
      session = new ClaudeSession(cwd, claude.path, broadcast);
    }
    return session;
  }

  async function capabilities(): Promise<Capabilities> {
    const s = ensureSession();
    if (!s.running) await s.start({});
    const c = await s.capabilities();
    capsCache = { ...c, modes: await permissionModes(claude.path!) };
    return capsCache;
  }

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    'GET /api/status': async () => ({ claude, project: projectPath ?? null, home: homedir(), platform: process.platform }),
    'POST /api/claude/recheck': async () => {
      claude = await detectClaude();
      return claude;
    },
    'GET /api/fs': async (_b, url) => listDir(resolve(url.searchParams.get('path') || homedir())),
    'POST /api/project': async (body) => {
      const p = await realpath(resolve(String(body.path ?? ''))).catch(() => resolve(String(body.path ?? '')));
      if (!(await stat(p).then((s) => s.isDirectory(), () => false))) throw new HttpError(400, `${p} is not a folder`);
      if (p !== projectPath) {
        session?.stop();
        session = undefined;
        capsCache = undefined;
        app.stop();
        storybook.stop();
      }
      projectPath = p;
      return projectInfo(p);
    },
    'GET /api/project': async () => projectInfo(requireProject()),
    'GET /api/capabilities': async () => capsCache ?? capabilities(),
    'POST /api/capabilities/refresh': async () => capabilities(),
    'GET /api/sessions': async () => {
      return listSessions(requireProject());
    },
    'GET /api/memory': async () => readMemory(requireProject()),
    'POST /api/memory': async (body) => {
      await writeMemory(requireProject(), String(body.path), String(body.content ?? ''));
      return readMemory(requireProject());
    },
    'GET /api/tokens': async () => findTokens(requireProject()),
    'POST /api/tokens': async (body) => {
      const r = await updateToken(requireProject(), String(body.file), Number(body.line), String(body.name), String(body.value));
      broadcast({ type: 'file-change', change: { toolUseId: `token-${Date.now()}`, tool: 'Token', path: r.path, before: r.before, after: r.after } });
      return findTokens(requireProject());
    },
    'GET /api/diff': async (_b, url) => diffFor(requireProject(), String(url.searchParams.get('path'))),
    'POST /api/git/latest': async () => getLatest(requireProject()),
    'POST /api/git/save': async (body) => saveVersion(requireProject(), String(body.message ?? '')),
    'POST /api/git/share': async (body) => shareForReview(requireProject(), String(body.title ?? '')),
    'POST /api/run/app': async () => ({ url: await app.start(requireProject()) }),
    'POST /api/run/storybook': async () => ({ url: await storybook.start(requireProject()) }),
    'GET /api/run': async () => ({ app: app.url ?? null, storybook: storybook.url ?? null }),
    'GET /api/figma/status': async (_b, url) => {
      const target = url.searchParams.get('url') || 'http://127.0.0.1:3845/mcp';
      try {
        const r = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'designer', version: '0.1.0' } } }),
          signal: AbortSignal.timeout(2500),
        });
        return { url: target, reachable: true, status: r.status };
      } catch {
        return { url: target, reachable: false };
      }
    },
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.headers['x-designer-token'] !== token) return json(res, 403, { error: 'Missing or wrong token' });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return json(res, 404, { error: 'Not found' });
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString() || '{}';
      body = JSON.parse(raw) as Record<string, unknown>;
    }
    try {
      json(res, 200, await route(body, url));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: (e as Error).message });
    }
  }

  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? opts.staticDir : undefined;
  const server = createServer(async (req, res) => {
    if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: 'Designer only answers on localhost' });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (!staticDir) return json(res, 404, { error: 'UI not built. Run npm run build, or use npm run dev.' });
    let file = normalize(join(staticDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(staticDir) || !(await stat(file).then((s) => s.isFile(), () => false))) file = join(staticDir, 'index.html');
    if (file.endsWith('index.html')) {
      // Hand the page its token in a cookie-free way: inline it.
      const { readFile } = await import('node:fs/promises');
      const html = (await readFile(file, 'utf8')).replace('</head>', `<script>window.__DESIGNER_TOKEN__=${JSON.stringify(token)}</script></head>`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const origin = req.headers.origin ?? '';
    const sameOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === 'file://';
    if (!isLoopbackHost(req.headers.host) || url.pathname !== '/ws' || url.searchParams.get('token') !== token || !sameOrigin) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    if (session) ws.send(JSON.stringify({ type: 'session', sessionId: session.sessionId, model: session.model, effort: session.effort, mode: session.mode, running: session.running, busy: session.busy } satisfies ServerMessage));
    // Handle one message at a time, so "start" finishes before the "prompt" sent right after it.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      chain = chain.then(() => handleMessage(ws, msg));
    });
  });

  async function handleMessage(ws: WebSocket, msg: ClientMessage) {
      try {
        const s = ensureSession();
        switch (msg.type) {
          case 'start':
            await s.start({ resume: msg.resume, model: msg.model, effort: msg.effort, mode: msg.mode });
            break;
          case 'prompt':
            if (!s.running) await s.start({ model: s.model, effort: s.effort, mode: s.mode, resume: s.sessionId });
            s.prompt(msg.text);
            break;
          case 'interrupt':
            await s.interrupt();
            break;
          case 'set-model':
            await s.setModel(msg.model);
            break;
          case 'set-mode':
            await s.setMode(msg.mode);
            break;
          case 'permission':
            s.answerPermission(msg.requestId, msg.allow, msg.message);
            break;
          case 'rewind':
            await s.rewind(msg.userMessageId, msg.dryRun);
            break;
          case 'connect-figma':
            await s.connectFigma(msg.url);
            break;
          case 'stop':
            s.stop();
            break;
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', text: (e as Error).message } satisfies ServerMessage));
      }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const close = () => {
    session?.stop();
    app.stop();
    storybook.stop();
    wss.close();
    server.close();
  };
  return { port, url: `http://${host}:${port}`, token, close };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
export { loadLoginShellEnv } from './claude.js';
