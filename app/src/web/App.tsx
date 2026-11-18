import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Capabilities, ClaudeInstall, ProjectInfo } from '../shared/protocol';
import { api, socket } from './api';
import { chatReducer, initialChat } from './store';
import { Chat, Menu, Spark, type CanvasContext, type Prefs } from './components/Chat';
import { Changes } from './components/Changes';
import { ClaudePanel, FigmaModal, SessionsPanel } from './components/ClaudePanel';
import { ProjectPicker } from './components/ProjectPicker';
import { DesignPanel } from './components/DesignPanel';
import { CodePanel, RenderedStyles, useCanvasTick } from './components/CodePanel';
import { ComponentsPanel } from './components/ComponentsPanel';
import { canvasHost, reconnectLive, type CanvasHost } from './canvas/host';

interface Status {
  claude: ClaudeInstall;
  project: string | null;
  home: string;
  workspace: string;
  platform: string;
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
  useEffect(() => {
    void api<Status>('/api/status').then(setStatus);
  }, []);
  if (!status) return <div className="welcome">Starting Designer…</div>;
  if (!status.claude.found || !status.claude.loggedIn) return <ClaudeSetup status={status} onRecheck={(c) => setStatus({ ...status, claude: c })} />;
  return <Workspace status={status} />;
}

function ClaudeSetup({ status, onRecheck }: { status: Status; onRecheck: (c: ClaudeInstall) => void }) {
  const c = status.claude;
  return (
    <div className="welcome">
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

type LeftTab = 'chat' | 'layers' | 'components';
type ChatView = 'chat' | 'history' | 'claude';

function Workspace({ status }: { status: Status }) {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [caps, setCaps] = useState<Capabilities>();
  const [capsError, setCapsError] = useState('');
  const [left, setLeft] = useState<LeftTab>('chat');
  const [chatView, setChatView] = useState<ChatView>('chat');
  const [side, setSide] = useState<'figma' | 'code'>('figma');
  const [codeTab, setCodeTab] = useState<'tokens' | 'changes'>('changes');
  const [modal, setModal] = useState<'save' | 'share' | 'figma' | 'project' | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [toast, setToast] = useState<{ text: string; url?: string }>();
  const [running, setRunning] = useState<{ app?: string | null; storybook?: string | null }>({});
  const [context, setContext] = useState<CanvasContext>();
  const [prefs, setPrefs] = useState<Prefs>(() => ({ model: lsGet('designer.model') ?? undefined, effort: lsGet('designer.effort') ?? undefined, mode: lsGet('designer.mode') ?? undefined }));
  const hostRef = useRef<CanvasHost>(undefined);
  if (!hostRef.current) hostRef.current = canvasHost(() => window.dispatchEvent(new CustomEvent('designer:focus-chat')));
  const host = hostRef.current;
  const editor = host.editor;
  useSelectionTick(editor);

  const loadCaps = useCallback((refresh = false) => {
    setCapsError('');
    return api<Capabilities>(refresh ? '/api/capabilities/refresh' : '/api/capabilities', refresh ? {} : undefined).then(setCaps, (e: Error) => setCapsError(e.message));
  }, []);

  const refreshProject = useCallback(() => api<ProjectInfo | null>('/api/project').then(setProject), []);

  // Start-up: reopen the last project quietly if there was one (never ask), then start Claude Code.
  useEffect(() => {
    socket.connect();
    const off = socket.on((m) => {
      if (m.type === 'project') {
        setProject(m.project);
        if (m.project) lsSet('designer.lastProject', m.project.path);
        else lsDel('designer.lastProject');
        setRunning({});
        void host.load();
        return;
      }
      if (m.type === 'run') {
        setRunning((r) => ({ ...r, [m.kind]: m.url }));
        if (m.kind === 'app') void host.showPage(m.url);
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
      const last = status.project ?? lsGet('designer.lastProject');
      if (last) {
        try {
          setProject(await api<ProjectInfo>('/api/project', { path: last }));
        } catch {
          lsDel('designer.lastProject');
        }
      }
      await host.load();
      const r = await api<{ app: string | null; storybook: string | null }>('/api/run').catch(() => ({ app: null, storybook: null }));
      setRunning(r);
      socket.send({ type: 'start', model: prefs.model, effort: prefs.effort, mode: prefs.mode });
      setTimeout(() => void loadCaps(), 400);
    })();
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live renders come back when their server is running again.
  useEffect(() => {
    if (running.storybook || running.app) void reconnectLive(host, running);
  }, [running, host]);

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
      const r = await api<{ ok: boolean; message: string; url?: string }>(path, body);
      setToast({ text: r.message, url: r.url });
      await refreshProject();
    } catch (e) {
      setToast({ text: (e as Error).message });
    }
  };

  const placeStory = async (storyId: string, nextTo = false) => {
    const entry = project?.stories.find((e) => e.stories.some((x) => x.id === storyId));
    const story = entry?.stories.find((x) => x.id === storyId);
    const title = entry ? `${entry.title.split('/').pop()}${story && entry.stories.length > 1 ? ` / ${story.name}` : ''}` : storyId;
    if (!running.storybook) setToast({ text: 'Starting Storybook to render the component…' });
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
        { label: 'Start a new project from scratch', prompt: 'Let’s start a new web project from scratch in Designer’s folder. Ask me what it’s for, then set it up with a component library and Storybook, open it, and run it.' },
        { label: 'Sketch a screen on the canvas', prompt: 'Sketch a clean sign-in screen on the canvas as editable layers, using auto layout.' },
      ];

  const changedFiles = new Set(chat.changes.map((c) => c.path)).size;
  const git = project?.git;
  const hasSelection = editor.store.selection.length > 0;

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
              <button className="opt" onClick={() => (ask('Work out how this project runs and start it so I can see it on the canvas.', false), setProjectMenu(false))}>
                <span>Run it</span>
              </button>
              <button className="opt" onClick={() => (void api('/api/project/close', {}), setProjectMenu(false))}>
                <span>Close project</span>
              </button>
            </Menu>
          )}
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setModal('figma')}>Import from Figma</button>
        {project ? (
          <>
            <button className="btn" onClick={() => gitAction('/api/git/latest', {})} disabled={!git?.remote} title="Pull what the team changed">
              Get latest {git && git.behind > 0 && <span className="badge dark">{git.behind}</span>}
            </button>
            <button className="btn" onClick={() => setModal('save')} disabled={!git?.isRepo}>
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
            {(['chat', 'layers', 'components'] as LeftTab[]).map((t) => (
              <button key={t} className={left === t ? 'on' : ''} onClick={() => setLeft(t)}>
                {t === 'chat' ? 'Chat' : t === 'layers' ? 'Layers' : 'Components'}
              </button>
            ))}
          </div>
          {capsError && left === 'chat' && <div className="error-box" style={{ margin: 8 }}>{capsError}</div>}
          <div className={`pane ${left === 'chat' ? '' : 'hidden'}`}>
            {chatView === 'chat' && <Chat chat={chat} caps={caps} prefs={prefs} onChoose={choose} context={context} hasProject={!!project} suggestions={suggestions} header={chatHeader} />}
            {chatView === 'history' && (
              <div className="chat" data-canvas-keys="off">
                {chatHeader}
                <SessionsPanel session={s} onResume={(id) => newChat(id)} />
              </div>
            )}
            {chatView === 'claude' && (
              <div className="chat" data-canvas-keys="off">
                {chatHeader}
                <ClaudePanel caps={caps} onRefresh={() => loadCaps(true)} />
              </div>
            )}
          </div>
          <div className={`pane ${left === 'layers' ? '' : 'hidden'}`}>
            <Adopt el={host.layersEl} />
          </div>
          <div className={`pane ${left === 'components' ? '' : 'hidden'}`} data-canvas-keys="off">
            <ComponentsPanel project={project} storybookRunning={!!running.storybook} onPlace={(id) => placeStory(id)} onAsk={(p) => ask(p, false)} onAddProject={() => setModal('project')} />
          </div>
        </aside>

        <main className="stage">
          <Adopt el={host.stage} className="stage-host" />
          <CanvasHint editor={editor} onFigma={() => setModal('figma')} onComponents={() => setLeft('components')} />
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
              </button>
            </div>
          </div>
          <div className={`pane ${side === 'figma' ? '' : 'hidden'}`}>
            <div className="scroll">
              <Adopt el={host.propsEl} />
              <RenderedStyles editor={editor} />
            </div>
          </div>
          <div className={`pane ${side === 'code' ? '' : 'hidden'}`} data-canvas-keys="off">
            {hasSelection ? (
              <CodePanel editor={editor} stories={project?.stories ?? []} onAsk={(p) => (p.endsWith(': ') ? (setLeft('chat'), setChatView('chat'), window.dispatchEvent(new CustomEvent('designer:focus-chat'))) : ask(p))} onShowStory={(id, next) => void placeStory(id, next)} />
            ) : project ? (
              <>
                <div className="tabs sub">
                  <button className={codeTab === 'changes' ? 'on' : ''} onClick={() => setCodeTab('changes')}>
                    Changes {changedFiles > 0 && <span className="badge dark">{changedFiles}</span>}
                  </button>
                  <button className={codeTab === 'tokens' ? 'on' : ''} onClick={() => setCodeTab('tokens')}>Tokens</button>
                </div>
                {codeTab === 'tokens' ? <DesignPanel onAsk={(p) => ask(p, false)} onChanged={() => void refreshProject()} /> : <Changes changes={chat.changes} git={project.git} />}
              </>
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
              onCancel={() => setModal(null)}
              onOpen={async (path) => {
                await api<ProjectInfo>('/api/project', { path });
                setModal(null);
              }}
            />
          </div>
        </div>
      )}
      {modal === 'save' && (
        <TextModal
          title="Save version"
          body="Saves everything that changed, the canvas included, as a version you can come back to."
          placeholder="What changed? e.g. Denser pricing cards"
          action="Save version"
          onClose={() => setModal(null)}
          onSubmit={(t) => gitAction('/api/git/save', { message: t })}
        />
      )}
      {modal === 'share' && (
        <TextModal
          title="Share for review"
          body="Sends your saved versions to the team as a pull request, on a branch of their own."
          placeholder="Title for the review"
          action="Share"
          onClose={() => setModal(null)}
          onSubmit={(t) => gitAction('/api/git/share', { title: t })}
        />
      )}
      {modal === 'figma' && <FigmaModal sessionRunning={s.running} onClose={() => (setModal(null), setLeft('chat'), setChatView('chat'))} />}
      {toast && (
        <div className="toast" onClick={() => setToast(undefined)}>
          {toast.text}
          {toast.url && (
            <>
              {' '}
              <a href={toast.url} target="_blank" rel="noreferrer" onClick={(e) => window.designerNative && (e.preventDefault(), window.designerNative.openExternal(toast.url!))}>
                Open
              </a>
            </>
          )}
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

function TextModal({ title, body, placeholder, action, onClose, onSubmit }: { title: string; body: string; placeholder: string; action: string; onClose: () => void; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-canvas-keys="off">
        <h3>{title}</h3>
        <p>{body}</p>
        <input className="input" style={{ width: '100%' }} autoFocus placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (onSubmit(text), onClose())} />
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => (onSubmit(text), onClose())}>{action}</button>
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
