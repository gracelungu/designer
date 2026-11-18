import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { detectClaude, permissionModes } from './claude.js';
import { ClaudeSession } from './session.js';
import { listSessions } from './transcripts.js';
import { findTokens, updateToken } from './tokens.js';
import { DevProcess, diffFor, findRunningStorybook, getLatest, listDir, projectInfo, readMemory, saveVersion, shareForReview, writeMemory } from './project.js';
import { PreviewProxies } from './proxy.js';
import { handleMcp, SYSTEM_PROMPT, type ToolHost } from './mcp.js';
import { FigmaClient, figmaStatus, parseOutline } from './figma.js';
import type { Capabilities, CanvasOp, CanvasState, ClaudeInstall, ClientMessage, ServerMessage } from '../shared/protocol.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  initialProject?: string;
  /** Fixed token, for the Vite dev setup only. */
  token?: string;
  /** Where Claude works before a project is open (default ~/Designer). */
  workspace?: string;
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
  let canvasState: CanvasState | undefined;
  const workspace = opts.workspace ?? join(homedir(), 'Designer');
  const sockets = new Set<WebSocket>();
  const app = new DevProcess('dev');
  const storybook = new DevProcess('storybook');
  const proxies = new PreviewProxies();
  let figma: FigmaClient | undefined;
  const waiting = new Map<string, (r: unknown) => void>();
  let serverUrl = '';

  const broadcast = (m: ServerMessage) => {
    const data = JSON.stringify(m);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  };

  function requireProject() {
    if (!projectPath) throw new HttpError(400, 'Add a project first.');
    return projectPath;
  }
  /** Where Claude works: the open project, or Designer's own folder before there is one. */
  const home = () => projectPath ?? workspace;

  function ensureSession(cwd?: string) {
    if (!claude.found || !claude.path) throw new HttpError(400, claude.error ?? 'Claude Code not found');
    if (!session || (cwd && session.cwd !== cwd)) {
      session?.stop();
      session = new ClaudeSession(cwd ?? home(), claude.path, broadcast, {
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: ['mcp__designer'],
        servers: { designer: { type: 'http', url: `${serverUrl}/mcp`, headers: { 'x-designer-token': token } } },
      });
      if (!projectPath) session.note(`No project is open yet. You are in Designer's own folder (${workspace}); new projects made from scratch can go here.`);
    }
    return session;
  }

  async function openProject(path: string, byClaude = false) {
    const p = await realpath(resolve(path)).catch(() => resolve(path));
    if (!(await stat(p).then((s) => s.isDirectory(), () => false))) throw new HttpError(400, `${p} is not a folder`);
    if (p !== projectPath) {
      app.stop();
      storybook.stop();
      projectPath = p;
      if (session && session.cwd !== p && !byClaude) session.note(`The user opened the project at ${p}. Work in that folder from now on (use absolute paths, and cd there before running commands).`);
    }
    const info = await projectInfo(p);
    broadcast({ type: 'project', project: info });
    return info;
  }

  async function askCanvas(op: CanvasOp): Promise<unknown> {
    if (![...sockets].some((s) => s.readyState === s.OPEN)) throw new Error('The Designer window is not open, so the canvas cannot be changed right now.');
    const requestId = randomBytes(8).toString('hex');
    return new Promise((done, fail) => {
      const t = setTimeout(() => (waiting.delete(requestId), fail(new Error('The canvas did not answer in time.'))), 10000);
      waiting.set(requestId, (r) => (clearTimeout(t), done(r)));
      broadcast({ type: 'canvas-op', requestId, op });
    });
  }

  async function runDev(kind: 'app' | 'storybook', command?: string) {
    if (kind === 'storybook' && !command?.trim()) return storybookUrl();
    return startDev(kind, command);
  }

  async function startDev(kind: 'app' | 'storybook', command?: string) {
    const cwd = requireProject();
    const dev = kind === 'app' ? app : storybook;
    const url = await dev.start(cwd, command);
    broadcast({ type: 'run', kind, url });
    return url;
  }

  async function storybookUrl() {
    const cwd = requireProject();
    if (storybook.url && storybook.adopted) {
      // Still up? The user may have stopped their own Storybook since.
      const alive = await fetch(`${storybook.url}/index.json`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
      if (alive) return storybook.url;
      storybook.stop();
    }
    if (storybook.url) return storybook.url;
    const info = await projectInfo(cwd);
    const running = await findRunningStorybook(
      info.stories.map((s) => s.file),
      info.scripts.storybook,
    );
    if (running) {
      storybook.adopt(cwd, running);
      broadcast({ type: 'run', kind: 'storybook', url: running });
      return running;
    }
    if (!info.scripts.storybook) throw new Error('Storybook is not running and this project has no "storybook" script. Start it with run_project (kind storybook), or set Storybook up first.');
    return startDev('storybook');
  }

  const tools: ToolHost = {
    openProject: async (path) => {
      const info = await openProject(path, true);
      const scripts = Object.entries(info.scripts).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';
      return `Opened ${info.path}.\nGit: ${info.git.isRepo ? `${info.git.branch ?? ''}${info.git.remote ? ` (remote ${info.git.remote})` : ' (no remote)'}` : 'not a git repository'}\nScripts:\n${scripts}\nStorybook stories: ${info.stories.reduce((n, s) => n + s.stories.length, 0)} in ${info.stories.length} files.\nNote: your own working folder is still ${session?.cwd ?? home()}; use absolute paths or cd into the project.`;
    },
    runProject: async (command, kind) => {
      try {
        const url = await runDev(kind, command);
        return `${kind === 'app' ? 'The app' : 'Storybook'} is running at ${url} and is on the canvas.`;
      } catch (e) {
        throw new Error(`Could not start it: ${(e as Error).message}`, { cause: e });
      }
    },
    canvasState: () => canvasState,
    addNodes: (nodes, nextToSelection) => askCanvas({ kind: 'add-nodes', nodes: nodes as never, nextToSelection, select: true }),
    updateNodes: (updates) => askCanvas({ kind: 'update-nodes', updates: updates as never }),
    showComponent: async (storyId, args, nextToSelection) => {
      if (!storyId) throw new Error('Give a story id.');
      const sb = await storybookUrl();
      const src = await proxies.url(`${sb}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`);
      const stories = projectPath ? (await projectInfo(projectPath)).stories : [];
      const entry = stories.find((e) => e.stories.some((s) => s.id === storyId));
      const story = entry?.stories.find((s) => s.id === storyId);
      const title = entry ? `${entry.title.split('/').pop()}${story && entry.stories.length > 1 ? ` / ${story.name}` : ''}` : storyId;
      const r = await askCanvas({ kind: 'show-component', storyId, title, src, args, nextToSelection, file: entry?.file });
      return `Placed ${title} on the canvas, rendered live from code. ${JSON.stringify(r)}`;
    },
  };

  async function capabilities(): Promise<Capabilities> {
    const s = ensureSession();
    if (!s.running) await s.start({});
    const c = await s.capabilities();
    capsCache = { ...c, modes: await permissionModes(claude.path!) };
    return capsCache;
  }

  async function canvasFile() {
    const dir = projectPath ? join(projectPath, '.designer') : workspace;
    return join(dir, 'canvas.json');
  }

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    'GET /api/status': async () => ({ claude, project: projectPath ?? null, home: homedir(), workspace, platform: process.platform }),
    'POST /api/claude/recheck': async () => {
      claude = await detectClaude();
      return claude;
    },
    'GET /api/fs': async (_b, url) => listDir(resolve(url.searchParams.get('path') || homedir())),
    'POST /api/project': async (body) => openProject(String(body.path ?? '')),
    'POST /api/project/close': async () => {
      app.stop();
      storybook.stop();
      projectPath = undefined;
      broadcast({ type: 'project', project: null });
      return { ok: true };
    },
    'GET /api/project': async () => (projectPath ? projectInfo(projectPath) : null),
    'GET /api/capabilities': async () => capsCache ?? capabilities(),
    'POST /api/capabilities/refresh': async () => capabilities(),
    'GET /api/sessions': async () => {
      return listSessions(home());
    },
    'GET /api/memory': async () => readMemory(home()),
    'POST /api/memory': async (body) => {
      await writeMemory(home(), String(body.path), String(body.content ?? ''));
      return readMemory(home());
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
    'POST /api/run/app': async (body) => ({ url: await runDev('app', body.command ? String(body.command) : undefined) }),
    'POST /api/run/storybook': async (body) => ({ url: await runDev('storybook', body.command ? String(body.command) : undefined) }),
    'GET /api/run': async () => ({ app: app.url ?? null, storybook: storybook.url ?? null }),
    'GET /api/preview': async (_b, url) => ({ src: await proxies.url(String(url.searchParams.get('url') ?? '')) }),
    'GET /api/story-src': async (_b, url) => {
      const sb = await storybookUrl();
      return { src: await proxies.url(`${sb}/iframe.html?id=${encodeURIComponent(String(url.searchParams.get('id') ?? ''))}&viewMode=story`) };
    },
    'GET /api/canvas': async () => {
      const f = await canvasFile();
      return { path: f, data: await readFile(f, 'utf8').then((t) => JSON.parse(t) as unknown, () => null) };
    },
    'POST /api/canvas': async (body) => {
      const f = await canvasFile();
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, JSON.stringify(body.data ?? null, null, 1));
      return { ok: true, path: f };
    },
    'GET /api/figma/status': async (_b, url) => {
      const custom = url.searchParams.get('url');
      const { status, client } = await figmaStatus(custom ? [custom] : undefined);
      figma = client;
      return status;
    },
    'GET /api/figma/node': async (_b, url) => {
      const id = String(url.searchParams.get('id') ?? '');
      if (!figma) throw new Error('Figma is not connected');
      const outline = parseOutline(await figma.metadata(id));
      return outline;
    },
    'GET /api/figma/thumb': async (_b, url) => {
      if (!figma) return { src: null };
      return { src: await figma.screenshot(String(url.searchParams.get('id') ?? '')).catch(() => null) };
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

  async function handleMcpHttp(req: IncomingMessage, res: ServerResponse) {
    if (req.headers['x-designer-token'] !== token) return json(res, 403, { error: 'Missing or wrong token' });
    if (req.method === 'DELETE') return json(res, 200, {});
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const out = await handleMcp(body, tools);
    if (out === null) {
      res.writeHead(202);
      return res.end();
    }
    return json(res, 200, out);
  }

  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? opts.staticDir : undefined;
  const server = createServer(async (req, res) => {
    if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: 'Designer only answers on localhost' });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/mcp') return handleMcpHttp(req, res);
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
        if (msg.type === 'canvas-state') {
          canvasState = msg.state;
          return;
        }
        if (msg.type === 'canvas-result') {
          const done = waiting.get(msg.requestId);
          waiting.delete(msg.requestId);
          done?.(msg.result);
          return;
        }
        if (msg.type === 'start') {
          // Continuing this conversation keeps its folder; a new chat starts in the open project.
          const cwd = msg.resume && session?.sessionId === msg.resume ? session.cwd : home();
          await ensureSession(cwd).start({ resume: msg.resume, model: msg.model, effort: msg.effort, mode: msg.mode });
          return;
        }
        const s = ensureSession();
        switch (msg.type) {
          case 'prompt':
            if (!s.running) await s.start({ model: s.model, effort: s.effort, mode: s.mode, resume: s.sessionId });
            s.prompt(msg.text, msg.attachments, msg.context);
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

  await mkdir(workspace, { recursive: true }).catch(() => undefined);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  serverUrl = `http://${host}:${port}`;
  const close = () => {
    session?.stop();
    app.stop();
    storybook.stop();
    proxies.closeAll();
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
