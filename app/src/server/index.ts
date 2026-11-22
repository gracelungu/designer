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
import { importVariables, pullFromFigma, setLink, tokenReport, useFigmaValue } from './designTokens.js';
import { addSourceComponent, DevProcess, diffFor, findRunningStorybook, getLatest, gitStatus, listDir, projectInfo, readMemory, saveVersion, shareForReview, writeMemory } from './project.js';
import { PreviewProxies } from './proxy.js';
import { describeSetup, ProjectRunner } from './runner.js';
import { planProject } from './setup.js';
import { handleMcp, serveMcp, SYSTEM_PROMPT, type ToolHost } from './mcp.js';
import { FigmaClient, figmaStatus, parseOutline } from './figma.js';
import { demoAvailable, installDemo } from './demo.js';
import { readSettings, writeSettings, type Settings } from './settings.js';
import { CodeSync, HeadWatcher } from './sync.js';
import type { LayerSync } from '../shared/protocol.js';
import { commentAuthor, describeComments, readComments, writeComments } from './comments.js';
import { buildPreview, previewLink, writePreview } from './preview.js';
import { AzureReviews, reviewProvider, type ReviewProvider } from './reviews.js';
import type { Capabilities, CanvasComment, CanvasOp, CanvasState, ClaudeInstall, ClientMessage, PreviewFrame, ServerMessage } from '../shared/protocol.js';
import { Camera, ReviewManager, reviewsDir, summarize, type Shooter } from './visual.js';
import { sendForReview } from './share.js';
import { designSyncNeeded, fetchTeamBranches, setTeamSync, syncDesignBranch, teamSyncStatus } from './teamSync.js';
import { createVariation, deleteVariation, history, mergeVariation, nameVersion, restoreVersion, switchVariation, syncWithTeam, versionFiles } from './versions.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  initialProject?: string;
  /** Fixed token, for the Vite dev setup only. */
  token?: string;
  /** Where Claude works before a project is open (default ~/Designer). */
  workspace?: string;
  /** Where to look for Figma's desktop MCP server (tests point this at a stand-in). */
  figmaUrls?: string[];
  /** Opt into running projects as soon as they are opened. */
  autoSetup?: boolean;
  /** The bundled demo project to copy from, if this build ships one. */
  demoDir?: string;
  /** Takes the before/after screenshots (default: a headless Chrome-family browser found on the computer). */
  shooter?: Shooter;
  /** The gh CLI used to open pull requests (default: gh on PATH). */
  gh?: string;
  /** Wait after a change before the after screenshots, for dev servers to rebuild (ms). */
  settleMs?: number;
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
  let projectPath: string | undefined;
  let session: ClaudeSession | undefined;
  let capsCache: Capabilities | undefined;
  let canvasState: CanvasState | undefined;
  const workspace = opts.workspace ?? join(homedir(), 'Designer');
  const sockets = new Set<WebSocket>();
  const app = new DevProcess('dev');
  const storybook = new DevProcess('storybook');
  const proxies = new PreviewProxies();
  let figma: FigmaClient | undefined;
  let reviews: { cwd: string; remote?: string; provider: ReviewProvider | null } | undefined;
  const waiting = new Map<string, (r: unknown) => void>();
  let serverUrl = '';
  // Setup: Claude reads the opened repo, works out how it runs and starts it (or Designer replays what worked last time).
  const setup = new ProjectRunner({
    claudePath: () => (claude.found && claude.loggedIn !== false ? claude.path : undefined),
    model: () => session?.model,
    mcp: (runId) => ({ type: 'http', url: `${serverUrl}/mcp/setup`, headers: { 'x-designer-token': token, 'x-designer-run': runId } }),
    app,
    storybook,
    publish: (state) => broadcast({ type: 'setup', setup: state }),
    onUrl: (kind, url) => broadcast({ type: 'run', kind, url }),
    onFinish: (state) => {
      if (session && state.project === projectPath) session.note(describeSetup(state));
    },
  });
  // Design -> code jobs, and the watcher that tells the canvas when code changed under it.
  const codeSync = new CodeSync({
    claudePath: () => (claude.found && claude.loggedIn !== false ? claude.path : undefined),
    cwd: () => requireProject(),
    send: (job) => broadcast({ type: 'sync', job }),
    model: () => session?.model,
  });
  const headWatcher = new HeadWatcher((change) => broadcast({ type: 'code-changed', change }));
  if (opts.initialProject) void headWatcher.watch(opts.initialProject);
  const shooter = opts.shooter ?? new Camera();
  const visualReviews = new ReviewManager({
    project: () => projectPath,
    shooter,
    // Only a Storybook that is already up: a screenshot never starts one (that can take minutes).
    urls: async () => {
      if (!projectPath || storybook.url) return { storybook: storybook.url ?? null, app: app.url ?? null };
      const info = await projectInfo(projectPath);
      return { storybook: (await findRunningStorybook(info.stories.map((s) => s.file), info.scripts.storybook)) ?? null, app: app.url ?? null };
    },
    stories: async (p) => (await projectInfo(p)).stories,
    canvas: async (p) => JSON.parse(await readFile(join(p, '.designer', 'canvas.json'), 'utf8')) as unknown,
    broadcast: (m) => broadcast(m),
    settleMs: opts.settleMs,
  });
  /** Tells the chat a review is ready, so the designer knows where to look. */
  const announce = (r: Awaited<ReturnType<ReviewManager['end']>>) => {
    if (r && r.shots.length) broadcast({ type: 'item', item: { kind: 'system', id: `review-${r.id}`, text: `Visual review ready: ${summarize(r)}. See Code › Changes.` } });
  };

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
        onTurnStart: (text) => visualReviews.begin(text),
        onEditStart: (abs) => visualReviews.beforeEdit(abs),
        onTurnEnd: () => void visualReviews.end().then(announce, () => undefined),
      });
      void addAzureServer();
      if (projectPath && setup.state?.project === projectPath && setup.state.status !== 'running') session.note(describeSetup(setup.state));
      if (!projectPath) session.note(`No project is open yet. You are in Designer's own folder (${workspace}); new projects made from scratch can go here.`);
    }
    return session;
  }

  /** Where Designer keeps its files: <project>/.designer, or Designer's own folder before a project. */
  const designerDir = () => (projectPath ? join(projectPath, '.designer') : workspace);

  async function currentReviews(): Promise<ReviewProvider | null> {
    const cwd = requireProject();
    const remote = (await gitStatus(cwd)).remote;
    if (!reviews || reviews.cwd !== cwd || reviews.remote !== remote) {
      reviews?.provider?.close();
      reviews = { cwd, remote, provider: reviewProvider(cwd, remote) };
    }
    return reviews.provider;
  }

  /** On an Azure DevOps project, Claude gets the Azure DevOps MCP server too, for PRs and their comments. */
  async function addAzureServer() {
    if (!projectPath || !session) return;
    const p = await currentReviews().catch(() => null);
    if (p instanceof AzureReviews) await session.addServer('azure-devops', p.mcpServerConfig()).catch(() => undefined);
  }

  async function saveComments(list: unknown[]) {
    const comments = await writeComments(designerDir(), list);
    broadcast({ type: 'comments', comments });
    return comments;
  }

  async function openProject(path: string, byClaude = false, autoRun = opts.autoSetup === true) {
    const p = await realpath(resolve(path)).catch(() => resolve(path));
    if (!(await stat(p).then((s) => s.isDirectory(), () => false))) throw new HttpError(400, `${p} is not a folder`);
    const isNew = p !== projectPath;
    if (isNew) {
      setup.cancel();
      app.stop();
      storybook.stop();
      projectPath = p;
      void headWatcher.watch(p);
      if (session && session.cwd !== p && !byClaude) session.note(`The user opened the project at ${p}. Work in that folder from now on (use absolute paths, and cd there before running commands).`);
    }
    const info = await projectInfo(p);
    broadcast({ type: 'project', project: info });
    if (isNew) broadcast({ type: 'setup', setup: null });
    // Setup: Claude works out how it runs and starts it (or the saved recipe does), in the background.
    if (autoRun && (isNew || setup.state?.status === 'failed')) void autoSetup(p);
    void addAzureServer();
    return info;
  }

  function autoSetup(p: string, fresh = false, localFirst = false) {
    return setup.start(p, { fresh, localFirst });
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
      const comps = info.components.slice(0, 40).map((c) => `  ${c.name} (${c.file}${c.storyIds.length ? `, stories: ${c.storyIds.join(', ')}` : ', no story'})`).join('\n');
      const s = setup.state;
      const how = s?.project === info.path
        ? s.status === 'running' ? 'A preview setup is running.' : describeSetup(s)
        : 'The component inventory is ready. Start a preview only if the task needs one.';
      return `Opened ${info.path}. ${how}\nComponents (${info.components.length}):\n${comps || '  (none found)'}\nGit: ${info.git.isRepo ? `${info.git.branch ?? ''}${info.git.remote ? ` (remote ${info.git.remote})` : ' (no remote)'}` : 'not a git repository'}\nScripts:\n${scripts}\nStorybook stories: ${info.stories.reduce((n, s) => n + s.stories.length, 0)} in ${info.stories.length} files.\nNote: your own working folder is still ${session?.cwd ?? home()}; use absolute paths or cd into the project.`;
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
    comments: async (includeResolved) => {
      const list = await readComments(designerDir());
      const layers = canvasState?.layers ?? [];
      return describeComments(list, (id) => (id ? (layers.find((l) => l.id === id)?.name ?? (id ? 'a layer' : undefined)) : undefined), includeResolved);
    },
    replyToComment: async (id, text, resolve) => {
      const list = await readComments(designerDir());
      const c = list.find((x) => x.id === id || `#${x.num}` === id || String(x.num) === id);
      if (!c) throw new Error(`No comment ${id}. Use get_comments for the ids.`);
      if (text.trim()) c.replies.push({ author: 'Claude', text: text.trim(), at: Date.now() });
      if (resolve !== undefined) c.resolved = resolve;
      await saveComments(list);
      return `${text.trim() ? 'Replied to' : 'Updated'} comment #${c.num}${resolve ? ' and resolved it' : resolve === false ? ' and reopened it' : ''}.`;
    },
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
    designTokens: async (status) => {
      if (!projectPath) throw new Error('No project is open.');
      const r = await tokenReport(projectPath);
      const pairs = status ? r.pairs.filter((p) => p.status === status) : r.pairs;
      return {
        figma: r.figma ?? 'No Figma variables pulled yet. The user can pull them from the Tokens tab, or you can read them with the figma MCP server (get_variable_defs).',
        summary: r.summary,
        tokens: pairs.map((p) => ({ status: p.status, mode: p.mode, figma: p.figma && `${p.figma.name} = ${p.figma.value}`, code: p.code && `${p.code.name} = ${p.code.value} (${p.code.file}:${p.code.line}, ${p.code.selector})` })),
      };
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

  let gitOperationRunning = false;
  async function gitOperation<T>(action: () => Promise<T>) {
    if (gitOperationRunning) throw new HttpError(409, 'Wait for the current Git action to finish.');
    gitOperationRunning = true;
    try {
      return await action();
    } finally {
      gitOperationRunning = false;
    }
  }

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    'GET /api/status': async () => {
      const settings = await readSettings(workspace);
      return { claude, project: projectPath ?? null, home: homedir(), workspace, platform: process.platform, onboarded: !!settings.onboardedAt, demo: await demoAvailable(opts.demoDir) };
    },
    'POST /api/onboarding': async (body) => {
      const startedWith = ['demo', 'project', 'blank'].includes(String(body.startedWith)) ? (String(body.startedWith) as Settings['startedWith']) : undefined;
      return writeSettings(workspace, { onboardedAt: new Date().toISOString(), startedWith });
    },
    'POST /api/onboarding/reset': async () => writeSettings(workspace, { onboardedAt: undefined, startedWith: undefined }),
    'POST /api/demo': async (body) => {
      if (!opts.demoDir) throw new HttpError(404, 'The demo project is not bundled with this copy of Designer.');
      const { path, created } = await installDemo(opts.demoDir, workspace, { fresh: body.fresh === true });
      const info = await openProject(path, false, typeof body.setup === 'boolean' ? body.setup : undefined);
      return { ...info, created };
    },
    'POST /api/claude/recheck': async () => {
      claude = await detectClaude();
      return claude;
    },
    'GET /api/fs': async (_b, url) => listDir(resolve(url.searchParams.get('path') || homedir())),
    'POST /api/project': async (body) => openProject(String(body.path ?? ''), false, typeof body.setup === 'boolean' ? body.setup : undefined),
    'POST /api/project/close': async () => {
      setup.cancel();
      broadcast({ type: 'setup', setup: null });
      app.stop();
      storybook.stop();
      projectPath = undefined;
      headWatcher.stop();
      broadcast({ type: 'project', project: null });
      return { ok: true };
    },
    'GET /api/project': async () => (projectPath ? projectInfo(projectPath) : null),
    'GET /api/project/setup': async () => setup.state ?? null,
    'POST /api/project/setup': async (body) => {
      const p = requireProject();
      // Answers right away; progress streams over the socket.
      void autoSetup(p, body.fresh === true, body.localFirst === true);
      await new Promise((r) => setTimeout(r, 50));
      return setup.state ?? null;
    },
    'GET /api/project/plan': async () => planProject(requireProject()),
    'GET /api/components': async () => (await projectInfo(requireProject())).components,
    'POST /api/components': async (body) => {
      const project = requireProject();
      if (body.project !== project) throw new HttpError(409, 'The open project changed. Open the component form again.');
      await addSourceComponent(project, { name: String(body.name ?? '').trim(), file: String(body.file ?? '').trim(), exportName: String(body.exportName ?? '').trim() });
      return projectInfo(project);
    },
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
      const r = await visualReviews.around(`Change ${String(body.name)} to ${String(body.value)}`, [String(body.file)], () => updateToken(requireProject(), String(body.file), Number(body.line), String(body.name), String(body.value)));
      broadcast({ type: 'file-change', change: { toolUseId: `token-${Date.now()}`, tool: 'Token', path: r.path, before: r.before, after: r.after } });
      return findTokens(requireProject());
    },
    'GET /api/tokens/sync': async () => tokenReport(requireProject()),
    'POST /api/tokens/sync/figma': async () => {
      const cwd = requireProject();
      let client = figma;
      if (!client) {
        const found = await figmaStatus(opts.figmaUrls);
        const status = found.status;
        client = figma = found.client;
        if (!client) throw new HttpError(400, status.state === 'not-running' ? 'Open the Figma desktop app with its MCP server turned on (Preferences › Enable Dev Mode MCP Server), select a frame that uses your variables, then pull again.' : `Figma: ${status.detail ?? 'not reachable'}`);
      }
      try {
        await pullFromFigma(cwd, client);
      } catch (e) {
        // A stale session (Figma restarted): reconnect once.
        if (/session|400|fetch failed/i.test((e as Error).message)) {
          const again = (await figmaStatus(opts.figmaUrls)).client;
          figma = again;
          if (!again) throw new HttpError(400, (e as Error).message);
          await pullFromFigma(cwd, again);
        } else throw new HttpError(400, (e as Error).message);
      }
      return tokenReport(cwd);
    },
    'POST /api/tokens/sync/import': async (body) => {
      const cwd = requireProject();
      await importVariables(cwd, String(body.text ?? '')).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      return tokenReport(cwd);
    },
    'POST /api/tokens/sync/link': async (body) => {
      const cwd = requireProject();
      await setLink(cwd, String(body.figma ?? ''), body.code ? String(body.code) : null);
      return tokenReport(cwd);
    },
    'POST /api/tokens/sync/use-figma': async (body) => {
      const cwd = requireProject();
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [String(body.key ?? '')];
      for (const key of keys) {
        const r = await useFigmaValue(cwd, key).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        broadcast({ type: 'file-change', change: { toolUseId: `token-${Date.now()}-${key}`, tool: 'Token', path: r.path, before: r.before, after: r.after } });
      }
      return tokenReport(cwd);
    },
    'GET /api/diff': async (_b, url) => diffFor(requireProject(), String(url.searchParams.get('path'))),
    'POST /api/git/latest': async () => gitOperation(async () => {
      const r = await getLatest(requireProject());
      // Tell the canvas what the pull changed, so linked layers can follow the code.
      const change = r.ok ? await headWatcher.check('pull') : null;
      return { ...r, files: change?.files ?? [] };
    }),
    'GET /api/sync': async () => codeSync.list(projectPath),
    'POST /api/sync/to-code': async (body) => {
      requireProject();
      return codeSync.start((body.layers ?? []) as LayerSync[]);
    },
    'POST /api/sync/keep': async (body) => codeSync.keep(String(body.id)),
    'POST /api/sync/discard': async (body) => codeSync.discard(String(body.id)),
    'POST /api/git/save': async (body) => gitOperation(async () => saveVersion(requireProject(), String(body.message ?? ''))),
    'POST /api/git/share': async (body) => gitOperation(async () => shareForReview(requireProject(), String(body.title ?? ''), { preview: !!body.preview })),
    'GET /api/visual-reviews': async () => visualReviews.list(),
    'POST /api/visual-reviews/retake': async (body) => visualReviews.retake(String(body.id)),
    'POST /api/visual-reviews/remove': async (body) => {
      await visualReviews.remove(String(body.id));
      return { ok: true };
    },
    'GET /api/visual-reviews/camera': async () => ({ available: shooter.available, reason: shooter.reason ?? null }),
    'POST /api/git/send': async (body) => {
      const cwd = requireProject();
      const all = await visualReviews.list();
      const ids = Array.isArray(body.reviewIds) ? (body.reviewIds as string[]) : all.filter((r) => !r.sentIn).map((r) => r.id);
      const chosen = all.filter((r) => ids.includes(r.id));
      const r = await sendForReview(cwd, {
        title: String(body.title ?? ''),
        description: body.description ? String(body.description) : undefined,
        reviews: chosen,
        reviewDir: (id) => join(reviewsDir(cwd), id),
        onStep: (step, state, detail) => broadcast({ type: 'share-step', step, state, detail }),
        gh: opts.gh,
        preview: !!body.preview,
      });
      if (r.ok && r.url) for (const v of chosen) await visualReviews.update(v.id, { sentIn: r.url }).catch(() => undefined);
      broadcast({ type: 'project', project: await projectInfo(cwd) });
      return r;
    },
    'GET /api/git/team': async () => teamSyncStatus(requireProject()),
    'POST /api/git/team/settings': async (body) => {
      const cwd = requireProject();
      if (body.project !== cwd) throw new HttpError(409, 'The open project changed. Configure sync from the current project.');
      return setTeamSync(cwd, body.enabled === true, String(body.branch ?? ''));
    },
    'POST /api/git/team/fetch': async () => gitOperation(async () => {
      await fetchTeamBranches(requireProject());
      return { ok: true, message: 'Team branches refreshed.' };
    }),
    'POST /api/git/team/check': async (body) => {
      const cwd = requireProject();
      if (body.project !== cwd) return { needed: false };
      return designSyncNeeded(cwd, String(body.branch ?? ''));
    },
    'POST /api/git/team/sync': async (body) => gitOperation(async () => {
      const cwd = requireProject();
      if (body.project !== cwd) throw new HttpError(409, 'The open project changed. Try again from the current project.');
      const result = await syncDesignBranch(cwd, String(body.branch ?? ''), body.automatic === true);
      if (result.changed && projectPath === cwd) await headWatcher.check('pull');
      return result;
    }),
    'GET /api/versions': async () => history(requireProject()),
    'GET /api/versions/files': async (_b, url) => versionFiles(requireProject(), String(url.searchParams.get('id') ?? '')),
    'POST /api/versions/name': async (body) => gitOperation(async () => afterGit(await nameVersion(requireProject(), String(body.name ?? ''), String(body.description ?? '')))),
    'POST /api/versions/restore': async (body) => gitOperation(async () => afterGit(await restoreVersion(requireProject(), String(body.id ?? '')), true)),
    'POST /api/variations/create': async (body) => gitOperation(async () => afterGit(await createVariation(requireProject(), String(body.name ?? '')))),
    'POST /api/variations/switch': async (body) => gitOperation(async () => afterGit(await switchVariation(requireProject(), String(body.name ?? '')), true)),
    'POST /api/variations/merge': async (body) => gitOperation(async () => afterGit(await mergeVariation(requireProject(), String(body.name ?? '')), true)),
    'POST /api/variations/delete': async (body) => gitOperation(async () => afterGit(await deleteVariation(requireProject(), String(body.name ?? '')))),
    'POST /api/git/sync': async () => gitOperation(async () => afterGit(await syncWithTeam(requireProject()), true)),
    'POST /api/run/app': async (body) => ({ url: await runDev('app', body.command ? String(body.command) : undefined) }),
    'POST /api/run/storybook': async (body) => ({ url: await runDev('storybook', body.command ? String(body.command) : undefined) }),
    'GET /api/run': async () => ({ app: app.url ?? null, storybook: storybook.url ?? null }),
    'GET /api/preview': async (_b, url) => ({ src: await proxies.url(String(url.searchParams.get('url') ?? '')) }),
    'GET /api/story-src': async (_b, url) => {
      const sb = url.searchParams.get('start') === 'false' ? storybook.url : await storybookUrl();
      if (!sb) throw new HttpError(409, 'Start Storybook to compare this design with the rendered component.');
      return { src: await proxies.url(`${sb}/iframe.html?id=${encodeURIComponent(String(url.searchParams.get('id') ?? ''))}&viewMode=story`) };
    },
    'GET /api/canvas': async () => {
      const f = await canvasFile();
      const data = await readFile(f, 'utf8').then((t) => JSON.parse(t) as { doc?: { comments?: unknown[] } } | null, () => null);
      let comments = await readComments(designerDir());
      // Canvases saved before comments had their own files kept them inside canvas.json: move them out.
      const old = data?.doc?.comments;
      if (!comments.length && Array.isArray(old) && old.length) comments = await writeComments(designerDir(), old);
      if (data?.doc) data.doc.comments = comments;
      return { path: f, data, comments, author: await commentAuthor(projectPath) };
    },
    'POST /api/canvas': async (body) => {
      const f = await canvasFile();
      await mkdir(dirname(f), { recursive: true });
      // Comments are saved one file per thread (see /api/comments), so they merge cleanly in git.
      const data = body.data as { doc?: Record<string, unknown> } | null;
      const doc = data?.doc ? { ...data.doc, comments: [] } : undefined;
      await writeFile(f, JSON.stringify(data ? { ...data, ...(doc ? { doc } : {}) } : null, null, 1));
      return { ok: true, path: f };
    },
    'GET /api/comments': async () => ({ comments: await readComments(designerDir()), author: await commentAuthor(projectPath) }),
    'POST /api/comments': async (body) => ({ comments: await saveComments(Array.isArray(body.comments) ? body.comments : []) }),
    'POST /api/preview': async (body) => {
      const frames = (Array.isArray(body.frames) ? body.frames : []) as PreviewFrame[];
      const comments: CanvasComment[] = await readComments(designerDir());
      const st = projectPath ? await gitStatus(projectPath) : undefined;
      const link = previewLink(st?.remote, st?.branch);
      const title = String(body.title || (projectPath ? `${projectPath.split(/[\\/]/).pop()} design preview` : 'Design preview'));
      const { files } = buildPreview({ title, frames, comments, link });
      const out = await writePreview(designerDir(), files);
      return { ok: true, dir: out.dir, files: out.files, link: link ?? null, html: files['index.html'], inProject: !!projectPath };
    },
    'GET /api/reviews/status': async () => {
      const p = await currentReviews();
      return p ? p.status() : { host: null, ready: false, problem: 'Pull requests show here for projects on GitHub or Azure DevOps.' };
    },
    'GET /api/reviews': async () => {
      const p = await currentReviews();
      return p ? p.list() : [];
    },
    'GET /api/reviews/threads': async (_b, url) => {
      const p = await currentReviews();
      if (!p) throw new HttpError(400, 'This project has no GitHub or Azure DevOps remote.');
      return p.threads(Number(url.searchParams.get('pr')));
    },
    'POST /api/reviews/reply': async (body) => {
      const p = await currentReviews();
      if (!p) throw new HttpError(400, 'This project has no GitHub or Azure DevOps remote.');
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, 'Write a reply first.');
      await p.reply(Number(body.pr), body.threadId ? String(body.threadId) : undefined, text);
      return p.threads(Number(body.pr));
    },
    'POST /api/reviews/resolve': async (body) => {
      const p = await currentReviews();
      if (!p?.resolve) throw new HttpError(400, 'Resolving threads from Designer works for Azure DevOps projects.');
      await p.resolve(Number(body.pr), String(body.threadId), !!body.resolved);
      return p.threads(Number(body.pr));
    },
    'GET /api/figma/status': async (_b, url) => {
      const custom = url.searchParams.get('url');
      const { status, client } = await figmaStatus(custom ? [custom] : opts.figmaUrls);
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

  /** After a version or variation change, the UI refreshes the project (and the canvas, which may differ). */
  async function afterGit<T extends { ok: boolean }>(r: T, contentChanged = false) {
    if (projectPath && (r.ok || contentChanged)) broadcast({ type: 'project', project: await projectInfo(projectPath) });
    return r;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    // Images go in <img src>, which can't send headers, so they take the token in the query.
    if (req.method === 'GET' && url.pathname === '/api/review-image') {
      if (url.searchParams.get('token') !== token) return json(res, 403, { error: 'Missing or wrong token' });
      try {
        const file = visualReviews.imagePath(String(url.searchParams.get('id')), String(url.searchParams.get('file')));
        if (!(await stat(file).then((s) => s.isFile(), () => false))) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return createReadStream(file).pipe(res);
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
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

  async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, serve: (body: unknown) => Promise<unknown> = (body) => handleMcp(body, tools)) {
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
    const out = await serve(body);
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
    if (url.pathname === '/mcp/setup') return handleMcpHttp(req, res, (body) => serveMcp(body, setup.tools(req.headers['x-designer-run'] as string | undefined)));
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
    if (setup.state) ws.send(JSON.stringify({ type: 'setup', setup: setup.state } satisfies ServerMessage));
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
  if (opts.initialProject) await openProject(opts.initialProject).catch(() => undefined);
  const close = () => {
    setup.cancel();
    session?.stop();
    headWatcher.stop();
    reviews?.provider?.close();
    app.stop();
    storybook.stop();
    proxies.closeAll();
    void shooter.close();
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
