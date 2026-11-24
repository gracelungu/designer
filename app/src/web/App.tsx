import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Capabilities, ClaudeInstall, ComponentEntry, ProjectInfo, SetupState, VisualReview } from '../shared/protocol';
import { api, socket } from './api';
import { chatReducer, initialChat } from './store';
import { Chat, Menu, Spark, type CanvasContext, type Prefs } from './components/Chat';
import { Changes } from './components/Changes';
import { ClaudePanel, SessionsPanel } from './components/ClaudePanel';
import { FigmaImport } from './components/FigmaImport';
import { ProjectPicker } from './components/ProjectPicker';
import { DesignPanel } from './components/DesignPanel';
import { CodePanel, RenderedStyles, useCanvasTick } from './components/CodePanel';
import { ComponentsPanel } from './components/ComponentsPanel';
import { LayerTokens } from './components/LayerTokens';
import { useTokenReport } from './tokens';
import { SetupCard } from './components/SetupCard';
import { canvasHost, reconnectLive, type CanvasHost } from './canvas/host';
import { Onboarding, type StartChoice } from './components/Onboarding';
import { UpdatePill } from './components/UpdatePill';
import { SyncBar, SyncPanel } from './components/SyncPanel';
import { SyncController } from './sync/controller';
import { CommentsPanel } from './components/CommentsPanel';
import { download } from '../../../editor/src/index.js';
import { ReviewViewer, SendForReview, VisualChanges } from './components/VisualReview';
import { useTeamSync } from './sync/team';
import { VersionsPanel } from './components/Versions';

interface Status {
  claude: ClaudeInstall;
  project: string | null;
  home: string;
  workspace: string;
  platform: string;
  onboarded: boolean;
  demo: boolean;
}

const Logo = () => (
  <svg className="logo" viewBox="0 0 22 22" aria-hidden="true">
    <rect width="22" height="22" rx="6" fill="#111" />
    <rect x="5" y="5" width="7" height="7" rx="1.5" fill="#fff" />
    <circle cx="13.5" cy="13.5" r="4" fill="none" stroke="#fff" strokeWidth="1.6" />
  </svg>
);

export function App() {
  const [status, setStatus] = useState<Status>();
  const [start, setStart] = useState<StartChoice>();
  useEffect(() => {
    void api<Status>('/api/status').then(setStatus);
  }, []);
  if (!status) return <div className="welcome">Starting Designer…</div>;
  if (!status.onboarded)
    return (
      <Onboarding demo={status.demo} home={status.home} onDone={(choice, project) => {
        setStart(choice);
        setStatus({ ...status, project: project ?? status.project, onboarded: true });
      }} />
    );
  return <Workspace status={status} start={start} onRecheck={(claude) => setStatus({ ...status, claude })} />;
}

function ClaudeSetup({ status, onRecheck }: { status: Status; onRecheck: (c: ClaudeInstall) => void }) {
  const c = status.claude;
  return (
    <div className="chat-setup">
      <div className="card">
        <Logo />
        <h2 style={{ marginTop: 10 }}>{!c.found ? 'Claude Code is not installed' : 'Sign in to Claude Code'}</h2>
        <p>Designer uses the Claude Code installed on this computer, with your own sign-in, settings, skills and MCP servers.</p>
        {!c.found ? (
          <p>
            Install it, then click Check again:
            <br />
            <code>curl -fsSL https://claude.ai/install.sh | bash</code>
          </p>
        ) : (
          <p>
            Found <code>{c.path}</code> ({c.version}), but it is not signed in. Open Terminal, run <code>claude</code> and sign in, then click Check again.
          </p>
        )}
        {c.error && <p className="error-box">{c.error}</p>}
        <button className="btn primary" onClick={() => api<ClaudeInstall>('/api/claude/recheck', {}).then(onRecheck)}>Check again</button>
      </div>
    </div>
  );
}

type LeftTab = 'chat' | 'layers' | 'components' | 'comments' | 'versions';
type ChatView = 'chat' | 'history' | 'claude';

function Workspace({ status, start, onRecheck }: { status: Status; start?: StartChoice; onRecheck: (claude: ClaudeInstall) => void }) {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [revealSetup, setRevealSetup] = useState(0);
  const [caps, setCaps] = useState<Capabilities>();
  const [capsError, setCapsError] = useState('');
  const [left, setLeft] = useState<LeftTab>(status.project || start === 'demo' ? 'components' : 'layers');
  const [chatView, setChatView] = useState<ChatView>('chat');
  const [side, setSide] = useState<'figma' | 'code'>('figma');
  const [codeTab, setCodeTab] = useState<'layer' | 'tokens' | 'changes'>('changes');
  const tokens = useTokenReport();
  const drift = tokens.report?.summary.drift ?? 0;
  const [modal, setModal] = useState<'save' | 'share' | 'figma' | 'project' | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const openingId = useRef(0);
  const [projectMenu, setProjectMenu] = useState(false);
  const [reviews, setReviews] = useState<VisualReview[]>([]);
  const [viewing, setViewing] = useState<VisualReview>();
  const [toast, setToast] = useState<{ text: string; url?: string; busy?: boolean }>();
  // Messages that are not progress go away by themselves; errors stay a little longer.
  useEffect(() => {
    if (!toast || toast.busy) return;
    const t = setTimeout(() => setToast(undefined), toast.text.length > 120 ? 20000 : 8000);
    return () => clearTimeout(t);
  }, [toast]);
  const [running, setRunning] = useState<{ app?: string | null; storybook?: string | null }>({});
  const [context, setContext] = useState<CanvasContext>();
  const [prefs, setPrefs] = useState<Prefs>(() => ({ model: lsGet('designer.model') ?? undefined, effort: lsGet('designer.effort') ?? undefined, mode: lsGet('designer.mode') ?? undefined }));
  const hostRef = useRef<CanvasHost>(undefined);
  if (!hostRef.current) hostRef.current = canvasHost(() => window.dispatchEvent(new CustomEvent('designer:focus-chat')));
  const host = hostRef.current;
  const editor = host.editor;
  useSelectionTick(editor);
  const syncRef = useRef<SyncController>(undefined);
  if (!syncRef.current) syncRef.current = new SyncController({ store: editor.store, measure: (id) => host.measureStory(id), reloadLive: () => host.reloadLive(), api });
  const sync = syncRef.current;
  const [syncOpen, setSyncOpen] = useState(false);
  // For automated checks (the smoke test drives the canvas through this).
  (window as unknown as { __designer?: unknown }).__designer = { host, sync };
  useCommentsTick(editor);

  const loadCaps = useCallback((refresh = false) => {
    setCapsError('');
    return api<Capabilities>(refresh ? '/api/capabilities/refresh' : '/api/capabilities', refresh ? {} : undefined).then(setCaps, (e: Error) => setCapsError(e.message));
  }, []);

  const refreshProject = useCallback(async () => {
    const next = await api<ProjectInfo | null>('/api/project');
    setProject((current) => current?.path === next?.path ? next : current);
  }, []);

  // Start-up: reopen the last project quietly if there was one (never ask), then start Claude Code.
  useEffect(() => {
    socket.connect();
    const off = socket.on((m) => {
      if (m.type === 'project') {
        setProject(m.project);
        if (m.project) lsSet('designer.lastProject', m.project.path);
        else lsDel('designer.lastProject');
        setRunning({});
        setSyncOpen(false);
        void sync.openProject(m.project?.path ?? null);
        const id = ++openingId.current;
        setOpeningProject(true);
        void host.load().finally(() => { if (id === openingId.current) setOpeningProject(false); });
        void api<VisualReview[]>('/api/visual-reviews').then(setReviews, () => setReviews([]));
        return;
      }
      if (m.type === 'component-catalog') {
        setProject((current) => current?.path === m.project.path ? m.project : current);
        if (m.project.catalog?.state === 'ready') host.reconnectComponents();
        return;
      }
      if (m.type === 'setup') {
        setSetup(m.setup);
        // A finished setup may have installed or found new things: refresh the components list.
        if (m.setup && m.setup.status !== 'running') void refreshProject();
        return;
      }
      if (m.type === 'review') {
        setReviews((list) => [m.review, ...list.filter((r) => r.id !== m.review.id)].sort((a, b) => b.createdAt - a.createdAt));
        setViewing((v) => (v?.id === m.review.id ? m.review : v));
        if (!m.review.capturing && m.review.shots.some((s) => s.changed)) setCodeTab('changes');
        return;
      }
      if (m.type === 'share-step') return;
      if (m.type === 'run') {
        setRunning((r) => ({ ...r, [m.kind]: m.url }));
        if (m.kind === 'app') void host.showPage(m.url);
        return;
      }
      if (m.type === 'sync') {
        if (!sync.onJob(m.job)) return;
        if (m.job.status === 'review') {
          setSide('code');
          setSyncOpen(true);
        }
        return;
      }
      if (m.type === 'code-changed') {
        void refreshProject();
        void sync.onCodeChanged(m.change);
        return;
      }
      if (m.type === 'comments') {
        host.setComments(m.comments);
        return;
      }
      if (m.type === 'canvas-op') {
        void host.apply(m.op).then(
          (result) => socket.send({ type: 'canvas-result', requestId: m.requestId, result }),
          (e: Error) => socket.send({ type: 'canvas-result', requestId: m.requestId, result: { error: e.message } }),
        );
        return;
      }
      dispatch(m);
      if (m.type === 'item' && m.item.kind === 'result') void refreshProject();
    });
    (async () => {
      let path = status.project;
      const last = path ?? lsGet('designer.lastProject');
      if (start === 'demo') {
        try {
          const info = await api<ProjectInfo>('/api/demo', { setup: false });
          path = info.path;
          setProject(info);
          setLeft('components');
        } catch (e) {
          setToast({ text: (e as Error).message });
        }
      } else if (start === 'blank' && path) {
        await api('/api/project/close', {});
        path = null;
      } else if ((!start || start === 'project') && last) {
        try {
          const info = await api<ProjectInfo>('/api/project', { path: last, setup: false });
          path = info.path;
          setProject(info);
          setLeft('components');
        } catch {
          lsDel('designer.lastProject');
        }
      }
      await host.load();
      void sync.openProject(path);
      void api<VisualReview[]>('/api/visual-reviews').then(setReviews, () => undefined);
      const r = await api<{ app: string | null; storybook: string | null }>('/api/run').catch(() => ({ app: null, storybook: null }));
      setRunning(r);
      setWorkspaceReady(true);
    })();
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentReady = Boolean(status.claude.found && status.claude.loggedIn);
  const agentStarted = useRef(false);
  useEffect(() => {
    if (!workspaceReady || !agentReady || agentStarted.current) return;
    agentStarted.current = true;
    socket.send({ type: 'start', model: prefs.model, effort: prefs.effort, mode: prefs.mode });
    setTimeout(() => void loadCaps(), 400);
  }, [workspaceReady, agentReady, prefs, loadCaps]);

  useEffect(() => {
    const showChat = () => { setLeft('chat'); setChatView('chat'); };
    window.addEventListener('designer:focus-chat', showChat);
    return () => window.removeEventListener('designer:focus-chat', showChat);
  }, []);

  // Live renders come back when their server is running again.
  useEffect(() => {
    if (openingProject) return;
    if (running.storybook || running.app) void reconnectLive(host, running);
    if (running.storybook) sync.recordUnmeasured();
  }, [running, host, sync, openingProject]);

  // Keep Claude and the chat's selection chip in step with the canvas.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return editor.store.on((ch) => {
      if (!ch.has('selection') && !ch.has('commit')) return;
      clearTimeout(t);
      t = setTimeout(() => {
        setContext(host.context());
        socket.send({ type: 'canvas-state', state: host.state() });
      }, 150);
    });
  }, [editor, host]);

  useEffect(() => {
    const figma = () => setModal('figma');
    window.addEventListener('designer:figma', figma);
    return () => window.removeEventListener('designer:figma', figma);
  }, []);

  const s = chat.session;
  const choose = (patch: Prefs) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    for (const [k, v] of Object.entries(patch)) if (v) lsSet(`designer.${k}`, v);
    if (patch.model && s.running) socket.send({ type: 'set-model', model: patch.model });
    else if (patch.mode && s.running) socket.send({ type: 'set-mode', mode: patch.mode });
    // Effort is fixed for a Claude Code process, so continue the same conversation in a new one.
    else socket.send({ type: 'start', resume: s.sessionId, model: next.model, effort: next.effort, mode: next.mode });
  };

  const ask = (text: string, withSelection = true) => {
    setLeft('chat');
    setChatView('chat');
    if (!agentReady) return;
    const ctx = withSelection ? host.context() : undefined;
    socket.send({ type: 'prompt', text, context: ctx?.text });
  };

  const newChat = (resume?: string) => {
    dispatch({ type: 'reset' });
    socket.send({ type: 'start', resume, model: prefs.model, effort: prefs.effort, mode: prefs.mode });
    setChatView('chat');
  };

  const gitAction = async (path: string, body: unknown) => {
    try {
      await host.flush();
      const r = await api<{ ok: boolean; message: string; url?: string; files?: string[] }>(path, body);
      setToast({ text: r.message, url: r.url });
      await refreshProject();
      // What the team changed in the design (canvas, comments) shows on the canvas straight away.
      // Code-only pulls leave the canvas alone: linked layers follow the code through sync instead.
      if (path === '/api/git/latest' && r.ok && (!r.files || r.files.some((f) => f.startsWith('.designer/')))) await host.load();
    } catch (e) {
      setToast({ text: (e as Error).message });
    }
  };

  /** Writes the shareable preview into the project (or Designer's folder) and downloads its page. */
  const exportPreview = async (opts: { quiet?: boolean } = {}) => {
    const r = await api<{ files: string[]; link: string | null; html: string; dir: string; inProject: boolean }>('/api/preview', { frames: host.previewFrames() });
    if (opts.quiet) return r;
    download('design-preview.html', r.html, 'text/html');
    setToast({
      text: r.inProject ? `Saved a design preview in .designer/preview and downloaded it. ${r.link ? 'Share for review to send developers the link.' : 'Save a version to keep it with the project.'}` : 'Downloaded the design preview.',
    });
    await refreshProject();
    return r;
  };



  const placeStory = async (storyId: string, nextTo = false) => {
    const entry = project?.stories.find((e) => e.stories.some((x) => x.id === storyId));
    const story = entry?.stories.find((x) => x.id === storyId);
    const title = entry ? `${entry.title.split('/').pop()}${story && entry.stories.length > 1 ? ` / ${story.name}` : ''}` : storyId;
    if (!running.storybook) setToast({ text: 'Starting your Storybook to render the component. The first start can take a minute.', busy: true });
    try {
      await host.placeStory(storyId, { title, file: entry?.file, nextToSelection: nextTo });
      setToast(undefined);
    } catch (e) {
      setToast({ text: (e as Error).message });
      throw e;
    }
  };

  const suggestions = project
    ? [
        { label: 'Run this project', prompt: 'Work out how this project runs and start it so I can see it on the canvas.' },
        { label: 'Put a component on the canvas', prompt: 'Show the most used component of this repo on the canvas, rendered from code.' },
        { label: 'Import my Figma selection', prompt: 'Read my current Figma selection with the figma MCP server and put it on the canvas as editable layers. If any part matches a component in this repo, show that component next to it.' },
        { label: 'Explain this repo’s design system', prompt: 'Give me a short tour of this repo’s design system: tokens, the main components and where they live.' },
      ]
    : [
        { label: 'Open a project from my dev folder', prompt: 'List the projects in my usual dev folders (like ~/dev, ~/code, ~/Projects) and ask me which one to open.' },
        { label: 'Start a new project from scratch', prompt: 'Let’s start a new web project from scratch in Designer’s folder. Ask me what it’s for, build the components, then open the project.' },
        { label: 'Sketch a screen on the canvas', prompt: 'Sketch a clean sign-in screen on the canvas as editable layers, using auto layout.' },
      ];

  const changedFiles = new Set(chat.changes.map((c) => c.path)).size;
  const git = project?.git;
  const afterTeamSync = useCallback(async (changed: boolean) => {
    if (changed) await reconnectLive(host, running);
    await refreshProject();
  }, [host, running, refreshProject]);
  const team = useTeamSync(project?.path, git?.branch, host,
    openingProject || !workspaceReady || !!modal || s.busy || setup?.status === 'running', afterTeamSync);
  const hasSelection = editor.store.selection.length > 0;
  // Selecting a layer shows its code; the Tokens and Changes tabs stay one click away.
  const [lastSel, setLastSel] = useState(hasSelection);
  if (lastSel !== hasSelection) {
    setLastSel(hasSelection);
    if (hasSelection) setCodeTab('layer');
    else if (codeTab === 'layer') setCodeTab('changes');
  }
  const openTokens = () => (setSide('code'), setCodeTab('tokens'));

  const openSync = () => { setSide('code'); setSyncOpen(true); };
  const runPreview = async (fresh = false) => {
    await api('/api/project/setup', { fresh, localFirst: true });
    setRevealSetup((n) => n + 1);
  };
  const placeDesign = async (component: ComponentEntry) => {
    await host.apply({
      kind: 'add-nodes',
      nextToSelection: true,
      nodes: [{ type: 'frame', name: component.name, w: 240, h: 120, codeLink: { file: component.file, exportName: component.exportName || undefined } }],
    });
  };

  const codePanel = (
    <CodePanel editor={editor} stories={project?.stories ?? []} components={project?.components ?? []} onReview={openSync} onAsk={(p) => (p.endsWith(': ') ? (setLeft('chat'), setChatView('chat'), window.dispatchEvent(new CustomEvent('designer:focus-chat'))) : ask(p))} onShowStory={(id, next) => void placeStory(id, next)} />
  );
  const openComments = host.comments().filter((c) => !c.resolved).length;

  const chatHeader = (
    <div className="chat-head">
      {chatView === 'chat' ? (
        <span className="chat-title">{chat.items.find((i) => i.kind === 'user')?.kind === 'user' ? (chat.items.find((i) => i.kind === 'user') as { text: string }).text.slice(0, 40) : 'New chat'}</span>
      ) : (
        <button className="chat-back" onClick={() => setChatView('chat')}>
          ‹ Back to chat
        </button>
      )}
      <span className="grow" />
      <button className="icon-btn" title="Chat history" aria-label="Chat history" onClick={() => setChatView(chatView === 'history' ? 'chat' : 'history')}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button className="icon-btn" title="Claude Code settings: MCP, memory, skills" aria-label="Claude Code settings" onClick={() => setChatView(chatView === 'claude' ? 'chat' : 'claude')}>
        <Spark size={14} />
      </button>
      <button className="icon-btn" title="New chat" aria-label="New chat" onClick={() => newChat()}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );

  return (
    <div className="app">
      <div className={`topbar ${status.platform === 'darwin' && window.designerNative ? 'mac' : ''}`}>
        <Logo />
        <div className="pop-anchor">
          <button className="chip" onClick={() => (project ? setProjectMenu(!projectMenu) : setModal('project'))} title={project?.path ?? 'Add a project'}>
            {project ? (
              <span className="chip-text">
                <b>{project.name}</b>
                <span className="sub">{git?.isRepo ? `${git.branch}${git.behind ? ` · ${git.behind} new from the team` : ''}` : 'Folder'}</span>
              </span>
            ) : (
              <span className="chip-text">
                <b>No project</b>
                <span className="sub">Add one, or mention it in chat</span>
              </span>
            )}
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          {projectMenu && project && (
            <Menu onClose={() => setProjectMenu(false)}>
              <div className="menu-note mono">{project.path}</div>
              <button className="opt" onClick={() => (setModal('project'), setProjectMenu(false))}>
                <span>Open another project…</span>
              </button>
              {git?.isRepo && (
                <button className="opt" onClick={() => { setProjectMenu(false); setLeft('versions'); }}>
                  <span>Team sync</span>
                </button>
              )}
              <button className="opt" onClick={() => { setProjectMenu(false); void runPreview().catch((e: Error) => setToast({ text: e.message })); }}>
                <span>Run full app</span>
              </button>
              {setup && (
                <button className="opt" onClick={() => (setRevealSetup((n) => n + 1), setProjectMenu(false))}>
                  <span>Show setup steps</span>
                </button>
              )}
              <button className="opt" onClick={() => (exportPreview().catch((e: Error) => setToast({ text: e.message })), setProjectMenu(false))}>
                <span>Export design preview</span>
              </button>
              <button className="opt" onClick={() => { setProjectMenu(false); void host.flush().then(() => api('/api/project/close', {})).catch((e: Error) => setToast({ text: e.message })); }}>
                <span>Close project</span>
              </button>
            </Menu>
          )}
        </div>
        <span className="spacer" />
        <UpdatePill />
        <button className="btn" onClick={() => setModal('figma')}>Import from Figma</button>
        {project ? (
          <>
            <button className="btn" onClick={() => gitAction('/api/git/latest', {})} disabled={!git?.remote} title="Pull what the team changed">
              Get latest {git && git.behind > 0 && <span className="badge dark">{git.behind}</span>}
            </button>
            <button className="btn" onClick={() => setModal('save')} disabled={!git?.isRepo} title="Add the current state to version history">
              Save version {git && git.changed.length > 0 && <span className="badge">{git.changed.length}</span>}
            </button>
            <button className="btn primary" onClick={() => setModal('share')} disabled={!git?.remote}>Share for review</button>
          </>
        ) : (
          <button className="btn primary" onClick={() => setModal('project')}>Add project</button>
        )}
      </div>

      <div className="body">
        <aside className="side left">
          <div className="tabs">
            {(['chat', 'layers', 'components', 'comments', 'versions'] as LeftTab[]).map((t) => (
              <button key={t} className={left === t ? 'on' : ''} onClick={() => setLeft(t)}>
                {t === 'chat' ? 'Chat' : t === 'layers' ? 'Layers' : t === 'components' ? 'Components' : t === 'comments' ? 'Comments' : 'Versions'}
                {t === 'comments' && openComments > 0 && <span className="badge dark">{openComments}</span>}
              </button>
            ))}
          </div>
          {capsError && left === 'chat' && <div className="error-box" style={{ margin: 8 }}>{capsError}</div>}
          <div className={`pane ${left === 'chat' ? '' : 'hidden'}`}>
            {!agentReady && left === 'chat' && <ClaudeSetup status={status} onRecheck={onRecheck} />}
            {agentReady && chatView === 'chat' && <Chat chat={chat} caps={caps} prefs={prefs} onChoose={choose} context={context} hasProject={!!project} suggestions={suggestions} header={chatHeader} />}
            {agentReady && chatView === 'history' && (
              <div className="chat" data-canvas-keys="off">
                {chatHeader}
                <SessionsPanel session={s} onResume={(id) => newChat(id)} />
              </div>
            )}
            {agentReady && chatView === 'claude' && (
              <div className="chat" data-canvas-keys="off">
                {chatHeader}
                <ClaudePanel caps={caps} onRefresh={() => loadCaps(true)} />
              </div>
            )}
          </div>
          <div className={`pane ${left === 'layers' ? '' : 'hidden'}`}>
            <Adopt el={host.layersEl} />
          </div>
          <div className={`pane ${left === 'comments' ? '' : 'hidden'}`}>
            <CommentsPanel
              comments={host.comments()}
              layerName={(id) => (id ? editor.store.get(id)?.name : undefined)}
              hasProject={!!project}
              onOpen={(id) => editor.comments.open(id)}
              onAsk={(p) => ask(p, false)}
              onAddComment={() => editor.setTool('comment')}
              onOpenUrl={(url) => (window.designerNative ? window.designerNative.openExternal(url) : window.open(url, '_blank', 'noopener'))}
            />
          </div>
          <div className={`pane ${left === 'components' ? '' : 'hidden'}`} data-canvas-keys="off">
            <ComponentsPanel
              key={project?.path}
              project={project}
              opening={openingProject || !workspaceReady}
              onPlace={async (component) => {
                if (project) await host.placeComponent(project.path, component);
              }}
              onDesign={placeDesign}
              onScan={async () => {
                const next = await api<ProjectInfo>('/api/components/scan', { project: project?.path });
                setProject((current) => current?.path === next.path ? next : current);
              }}
              onAddProject={() => setModal('project')}
            />
          </div>
          <div className={`pane ${left === 'versions' ? '' : 'hidden'}`}>
            {left === 'versions' && <VersionsPanel project={project?.path} onToast={setToast} onAsk={(p) => ask(p, false)} flushCanvas={host.flush} team={team} />}
          </div>
        </aside>

        <main className="stage">
          <Adopt el={host.stage} className="stage-host" />
          <SyncBar sync={sync} onOpen={openSync} />
          <CanvasHint editor={editor} onFigma={() => setModal('figma')} onComponents={() => setLeft('components')} />
          <SetupCard setup={setup} agentReady={agentReady} reveal={revealSetup} onRetry={(fresh) => void runPreview(fresh).catch((e: Error) => setToast({ text: e.message }))} onAgentSetup={() => setLeft('chat')} />
        </main>

        <aside className="side right">
          <div className="side-switch">
            <div className="segmented full" role="tablist" aria-label="Properties">
              <button role="tab" aria-selected={side === 'figma'} className={side === 'figma' ? 'on' : ''} onClick={() => setSide('figma')}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
                Figma
              </button>
              <button role="tab" aria-selected={side === 'code'} className={side === 'code' ? 'on' : ''} onClick={() => setSide('code')}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Code
                {changedFiles > 0 && <span className="badge dark">{changedFiles}</span>}
                {drift > 0 && (
                  <span className="badge" title={`${drift} token${drift === 1 ? '' : 's'} differ between Figma and code`} aria-label={`${drift} tokens differ`}>
                    {drift}!
                  </span>
                )}
              </button>
            </div>
          </div>
          <div className={`pane ${side === 'figma' ? '' : 'hidden'}`}>
            <div className="scroll">
              <Adopt el={host.propsEl} />
              <RenderedStyles editor={editor} />
              {project && <LayerTokens editor={editor} onOpenTokens={openTokens} />}
            </div>
          </div>
          <div className={`pane ${side === 'code' ? '' : 'hidden'}`} data-canvas-keys="off">
            {syncOpen ? (
              <SyncPanel sync={sync} agentReady={agentReady} onClose={() => setSyncOpen(false)} onSelect={(id) => {
                editor.store.select([id]);
                editor.zoomToSelection();
              }} />
            ) : project ? (
              <>
                <div className="tabs sub">
                  {hasSelection && (
                    <button className={codeTab === 'layer' ? 'on' : ''} onClick={() => setCodeTab('layer')}>
                      Layer
                    </button>
                  )}
                  <button className={codeTab === 'changes' ? 'on' : ''} onClick={() => setCodeTab('changes')}>
                    Changes {changedFiles > 0 && <span className="badge dark">{changedFiles}</span>}
                  </button>
                  <button className={codeTab === 'tokens' ? 'on' : ''} onClick={() => setCodeTab('tokens')}>
                    Tokens {drift > 0 && <span className="badge">{drift}</span>}
                  </button>
                  <button onClick={() => setSyncOpen(true)}>Sync</button>
                </div>
                {codeTab === 'layer' && hasSelection ? (
                  codePanel
                ) : codeTab === 'tokens' ? (
                  <DesignPanel onAsk={(p) => ask(p, false)} onChanged={() => void refreshProject()} />
                ) : (
                  <Changes changes={chat.changes} git={project.git} visual={<VisualChanges reviews={reviews} onOpen={setViewing} />} />
                )}
              </>
            ) : hasSelection ? (
              codePanel
            ) : (
              <div className="empty">Select a layer to see it as code. Add a project to see its tokens and what changed.</div>
            )}
          </div>
        </aside>
      </div>

      {modal === 'project' && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <ProjectPicker
              home={status.home}
              current={project?.path}
              onDemo={status.demo ? async () => {
                await host.flush();
                await api<ProjectInfo>('/api/demo', { setup: false });
                setLeft('components');
                setModal(null);
              } : undefined}
              onCancel={() => setModal(null)}
              onOpen={async (path) => {
                await host.flush();
                await api<ProjectInfo>('/api/project', { path, setup: false });
                setLeft('components');
                setModal(null);
              }}
            />
          </div>
        </div>
      )}
      {modal === 'save' && (
        <TextModal
          title="Add to version history"
          body="Saves everything that changed, the canvas included, as a named version you can come back to from the Versions tab."
          placeholder="Title, e.g. Denser pricing cards"
          action="Save version"
          onClose={() => setModal(null)}
          onSubmit={(t) => gitAction('/api/versions/name', { name: t || 'Design update' })}
        />
      )}
      {modal === 'share' && (
        <SendForReview reviews={reviews} unsaved={git?.changed.length ?? 0} onClose={() => setModal(null)} onDone={() => void refreshProject()} onPreview={() => exportPreview({ quiet: true })} />
      )}
      {viewing && <ReviewViewer review={viewing} onClose={() => setViewing(undefined)} onAsk={(p) => (setLeft('chat'), setChatView('chat'), window.dispatchEvent(new CustomEvent('designer:prefill', { detail: p })))} />}
      {modal === 'figma' && <FigmaImport sessionRunning={s.running} onClose={() => (setModal(null), setLeft('chat'), setChatView('chat'))} />}
      {toast && (
        <div className={`toast ${toast.busy ? 'busy' : ''}`} role="status">
          {toast.busy && <span className="toast-spin" />}
          <span className="toast-text">{toast.text}</span>
          {toast.url && (
            <>
              {' '}
              <a href={toast.url} target="_blank" rel="noreferrer" onClick={(e) => window.designerNative && (e.preventDefault(), window.designerNative.openExternal(toast.url!))}>
                Open
              </a>
            </>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(undefined)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** Re-renders when the selection changes (not on every drag frame). */
function useSelectionTick(editor: CanvasHost['editor']) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => editor.store.on((ch) => (ch.has('selection') ? tick() : undefined)), [editor]);
}

/** Re-renders when comments may have changed (a commit, or comments arriving from the team or Claude). */
function useCommentsTick(editor: CanvasHost['editor']) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let last = '';
    return editor.store.on((ch) => {
      if (!ch.has('commit') && !ch.has('comments') && !ch.has('doc')) return;
      const now = JSON.stringify(editor.store.doc.comments ?? []);
      if (now === last) return;
      last = now;
      tick();
    });
  }, [editor]);
}

/** Shows a DOM element owned by the canvas (layers, properties, the canvas itself) inside React's tree. */
function Adopt({ el, className }: { el: HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.append(el);
  }, [el]);
  return <div ref={ref} className={className} />;
}

function CanvasHint({ editor, onFigma, onComponents }: { editor: CanvasHost['editor']; onFigma: () => void; onComponents: () => void }) {
  useCanvasTick(editor);
  if (editor.store.doc.root.length) return null;
  return (
    <div className="canvas-hint">
      <b>A blank canvas</b>
      <span>Draw with the tools below (F frame, R rectangle, T text), drop an image, or bring something in:</span>
      <div className="row-actions">
        <button className="btn small" onClick={onFigma}>Import from Figma</button>
        <button className="btn small" onClick={onComponents}>Place a component from code</button>
        <button className="btn small" onClick={() => window.dispatchEvent(new CustomEvent('designer:focus-chat'))}>Ask Claude</button>
      </div>
    </div>
  );
}

function TextModal({ title, body, placeholder, action, option, onClose, onSubmit }: { title: string; body: string; placeholder: string; action: string; option?: string; onClose: () => void; onSubmit: (t: string, option?: boolean) => void }) {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState(true);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-canvas-keys="off">
        <h3>{title}</h3>
        <p>{body}</p>
        <input className="input" style={{ width: '100%' }} autoFocus placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (onSubmit(text, option ? checked : undefined), onClose())} />
        {option && (
          <label className="modal-option">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {option}
          </label>
        )}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => (onSubmit(text, option ? checked : undefined), onClose())}>{action}</button>
        </div>
      </div>
    </div>
  );
}

function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private windows can refuse storage; preferences just won't persist.
  }
}
function lsDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
