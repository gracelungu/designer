import { useCallback, useEffect, useReducer, useState } from 'react';
import type { Capabilities, ClaudeInstall, ProjectInfo } from '../shared/protocol';
import { api, socket } from './api';
import { chatReducer, initialChat } from './store';
import { Chat } from './components/Chat';
import { Canvas } from './components/Canvas';
import { ComponentsView } from './components/ComponentsView';
import { Changes } from './components/Changes';
import { ClaudePanel, FigmaModal, SessionsPanel } from './components/ClaudePanel';
import { ProjectPicker } from './components/ProjectPicker';
import { DesignPanel } from './components/DesignPanel';

interface Status {
  claude: ClaudeInstall;
  project: string | null;
  home: string;
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
  const [project, setProject] = useState<ProjectInfo>();
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    api<Status>('/api/status').then(async (s) => {
      setStatus(s);
      const last = s.project ?? localStorageGet('designer.lastProject');
      if (last && s.claude.found) api<ProjectInfo>('/api/project', { path: last }).then(setProject, () => setPicking(true));
      else setPicking(true);
    });
  }, []);

  if (!status) return <div className="welcome">Starting Designer…</div>;
  if (!status.claude.found || !status.claude.loggedIn) return <ClaudeSetup status={status} onRecheck={(c) => setStatus({ ...status, claude: c })} />;
  if (!project || picking)
    return (
      <ProjectPicker
        home={status.home}
        current={project?.path}
        onCancel={project ? () => setPicking(false) : undefined}
        onOpen={async (path) => {
          const p = await api<ProjectInfo>('/api/project', { path });
          localStorageSet('designer.lastProject', path);
          setProject(p);
          setPicking(false);
        }}
      />
    );
  return <Workspace key={project.path} project={project} setProject={setProject} claude={status.claude} onSwitch={() => setPicking(true)} isMac={status.platform === 'darwin'} />;
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

type LeftTab = 'chat' | 'sessions' | 'claude';

function Workspace({ project, setProject, claude, onSwitch, isMac }: { project: ProjectInfo; setProject: (p: ProjectInfo) => void; claude: ClaudeInstall; onSwitch: () => void; isMac: boolean }) {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const [caps, setCaps] = useState<Capabilities>();
  const [capsError, setCapsError] = useState('');
  const [left, setLeft] = useState<LeftTab>('chat');
  const [view, setView] = useState<'canvas' | 'components'>('canvas');
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<{ text: string; url?: string }>();
  const [modal, setModal] = useState<'save' | 'share' | 'figma' | null>(null);
  const [appUrl, setAppUrl] = useState<string>();
  const [storybookUrl, setStorybookUrl] = useState<string>();
  const [starting, setStarting] = useState<'app' | 'storybook' | null>(null);
  const [context, setContext] = useState<string>();
  const [right, setRight] = useState<'design' | 'changes'>('design');
  const [reloadKey, setReloadKey] = useState(0);
  const [prefs, setPrefs] = useState(() => ({ model: localStorageGet('designer.model') ?? undefined, effort: localStorageGet('designer.effort') ?? undefined, mode: localStorageGet('designer.mode') ?? undefined }));

  const refreshProject = useCallback(() => api<ProjectInfo>('/api/project').then(setProject), [setProject]);
  const loadCaps = useCallback((refresh = false) => {
    setCapsError('');
    return api<Capabilities>(refresh ? '/api/capabilities/refresh' : '/api/capabilities', refresh ? {} : undefined).then(setCaps, (e: Error) => setCapsError(e.message));
  }, []);

  useEffect(() => {
    socket.connect();
    const off = socket.on((m) => {
      dispatch(m);
      if (m.type === 'item' && m.item.kind === 'result') {
        void refreshProject();
        // Dev servers with hot reload update the frames themselves; a reload covers the ones without it.
        setReloadKey((k) => k + 1);
      }
    });
    // Start Claude Code in this folder with the last-used model, effort and mode, then read what it offers.
    socket.send({ type: 'start', model: prefs.model, effort: prefs.effort, mode: prefs.mode });
    const t = setTimeout(() => void loadCaps(), 300);
    api<{ app: string | null; storybook: string | null }>('/api/run').then((r) => {
      if (r.app) setAppUrl(r.app);
      if (r.storybook) setStorybookUrl(r.storybook);
    });
    const onUrl = (e: Event) => setAppUrl((e as CustomEvent<string>).detail);
    window.addEventListener('designer:app-url', onUrl);
    return () => {
      off();
      clearTimeout(t);
      window.removeEventListener('designer:app-url', onUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = chat.session;
  const model = caps?.models.find((m) => m.value === s.model) ?? caps?.models.find((m) => m.value === 'default') ?? caps?.models[0];
  const modeInfo = caps?.modes.find((m) => m.value === s.mode) ?? caps?.modes[0];
  const modes = caps?.modes.filter((m) => m.value !== 'auto' || model?.supportsAutoMode) ?? [];

  const choose = (patch: { model?: string; effort?: string; mode?: string }) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    for (const [k, v] of Object.entries(patch)) if (v) localStorageSet(`designer.${k}`, v);
    if (patch.model && s.running) socket.send({ type: 'set-model', model: patch.model });
    else if (patch.mode && s.running) socket.send({ type: 'set-mode', mode: patch.mode });
    // Effort is fixed for a Claude Code process, so continue the same conversation in a new one.
    else socket.send({ type: 'start', resume: s.sessionId, model: next.model, effort: next.effort, mode: next.mode });
  };

  const ask = (text: string) => {
    setLeft('chat');
    socket.send({ type: 'prompt', text });
  };

  const runDev = async (which: 'app' | 'storybook') => {
    setStarting(which);
    try {
      const r = await api<{ url: string }>(`/api/run/${which}`, {});
      if (which === 'app') setAppUrl(r.url);
      else setStorybookUrl(r.url);
    } catch (e) {
      setToast({ text: (e as Error).message });
    } finally {
      setStarting(null);
    }
  };

  const gitAction = async (path: string, body: unknown) => {
    try {
      const r = await api<{ ok: boolean; message: string; url?: string }>(path, body);
      setToast({ text: r.message, url: r.url });
      await refreshProject();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setToast({ text: (e as Error).message });
    }
  };

  const lastUser = [...chat.items].reverse().find((i) => i.kind === 'user' && i.userMessageId);
  const changedCount = project.git.changed.length;

  return (
    <div className="app">
      <div className={`topbar ${isMac && window.designerNative ? 'mac' : ''}`}>
        <Logo />
        <button className="chip" onClick={onSwitch} title={project.path}>
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <b>{project.name}</b>
            <span className="sub">{project.git.isRepo ? `${project.git.branch}${project.git.behind ? ` · ${project.git.behind} new from team` : ''}` : 'Not a git repository'}</span>
          </span>
        </button>
        <button
          className="icon-btn"
          title="Undo Claude's last change"
          disabled={!lastUser}
          onClick={() => lastUser && lastUser.kind === 'user' && confirm('Undo the file changes from your last message to Claude?') && socket.send({ type: 'rewind', userMessageId: lastUser.userMessageId! })}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3L2.5 6L5.5 9M2.5 6H10A3.5 3.5 0 0 1 10 13H7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="spacer" />
        <div className="segmented">
          <button className={view === 'canvas' ? 'on' : ''} onClick={() => setView('canvas')}>Canvas</button>
          <button className={view === 'components' ? 'on' : ''} onClick={() => setView('components')}>Components</button>
        </div>
        <div className="spacer" />
        <div style={{ position: 'relative' }}>
          <button className="chip" onClick={() => setMenu(!menu)} title={`Claude Code ${caps?.claudeVersion ?? claude.version ?? ''}`}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5L9.4 6.6L14.5 8L9.4 9.4L8 14.5L6.6 9.4L1.5 8L6.6 6.6Z" fill="#111" /></svg>
            <b>{model?.displayName ?? s.model ?? 'Claude'}</b>
            <span className="muted">· {s.effort ?? prefs.effort ?? 'auto effort'} · {modeInfo?.label ?? s.mode}</span>
            {s.busy && <span className="status-dot wait" />}
          </button>
          {menu && caps && (
            <div className="popover" style={{ right: 0, top: 38 }} onMouseLeave={() => setMenu(false)}>
              <h4>Model</h4>
              {caps.models.map((m) => (
                <button key={m.value} className="opt" onClick={() => choose({ model: m.value })}>
                  <span className="check">{m.value === model?.value ? '✓' : ''}</span>
                  <span>
                    {m.displayName}
                    <small>{m.description}</small>
                  </span>
                </button>
              ))}
              {model && model.supportedEffortLevels.length > 0 && (
                <>
                  <h4>Effort</h4>
                  <div className="efforts">
                    {model.supportedEffortLevels.map((e) => (
                      <button key={e} className={(s.effort ?? prefs.effort) === e ? 'on' : ''} onClick={() => choose({ effort: e })}>
                        {e}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <h4>Mode</h4>
              {modes.map((m) => (
                <button key={m.value} className="opt" onClick={() => choose({ mode: m.value })}>
                  <span className="check">{m.value === modeInfo?.value ? '✓' : ''}</span>
                  <span>
                    {m.label}
                    <small>{m.description}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn" onClick={() => setModal('figma')}>Import from Figma</button>
        <button className="btn" onClick={() => gitAction('/api/git/latest', {})} disabled={!project.git.remote}>
          Get latest {project.git.behind > 0 && <span className="badge dark">{project.git.behind}</span>}
        </button>
        <button className="btn" onClick={() => setModal('save')} disabled={!project.git.isRepo}>
          Save version {changedCount > 0 && <span className="badge">{changedCount}</span>}
        </button>
        <button className="btn primary" onClick={() => setModal('share')} disabled={!project.git.remote}>Share for review</button>
      </div>

      <div className="body">
        <div className="side">
          <div className="tabs">
            {(['chat', 'sessions', 'claude'] as LeftTab[]).map((t) => (
              <button key={t} className={left === t ? 'on' : ''} onClick={() => setLeft(t)}>
                {t === 'chat' ? 'Chat' : t === 'sessions' ? 'Sessions' : 'Claude Code'}
              </button>
            ))}
          </div>
          {capsError && <div className="error-box" style={{ margin: 8 }}>{capsError}</div>}
          {left === 'chat' && <Chat chat={chat} commands={caps?.commands ?? []} context={context} clearContext={() => setContext(undefined)} />}
          {left === 'sessions' && (
            <SessionsPanel
              session={s}
              onResume={(id) => {
                dispatch({ type: 'reset' });
                socket.send({ type: 'start', resume: id, model: prefs.model, effort: prefs.effort, mode: prefs.mode });
                setLeft('chat');
              }}
            />
          )}
          {left === 'claude' && <ClaudePanel caps={caps} onRefresh={() => loadCaps(true)} />}
        </div>

        {view === 'canvas' ? (
          <Canvas appUrl={appUrl} scripts={project.scripts} running={starting === 'app'} onRunApp={() => runDev('app')} onAsk={(c) => (setContext(c), setLeft('chat'))} reloadKey={reloadKey} />
        ) : (
          <ComponentsView
            stories={project.stories}
            storybookUrl={storybookUrl}
            hasScript={!!project.scripts.storybook}
            starting={starting === 'storybook'}
            onStart={() => runDev('storybook')}
            onAsk={(t) => (t.startsWith('Context:') ? (setContext(t), setLeft('chat')) : ask(t))}
            reloadKey={reloadKey}
          />
        )}

        <div className="side right">
          <div className="tabs">
            <button className={right === 'design' ? 'on' : ''} onClick={() => setRight('design')}>Design</button>
            <button className={right === 'changes' ? 'on' : ''} onClick={() => setRight('changes')}>
              Changes {chat.changes.length > 0 && <span className="badge dark" style={{ display: 'inline-grid', marginLeft: 4 }}>{new Set(chat.changes.map((c) => c.path)).size}</span>}
            </button>
          </div>
          {right === 'design' ? (
            <DesignPanel onAsk={ask} onChanged={() => (void refreshProject(), setReloadKey((k) => k + 1))} />
          ) : (
            <Changes changes={chat.changes} git={project.git} />
          )}
        </div>
      </div>

      {modal === 'save' && (
        <TextModal
          title="Save version"
          body="Saves everything that changed as a version you can come back to."
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
      {modal === 'figma' && <FigmaModal sessionRunning={s.running} onClose={() => setModal(null)} />}
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

function TextModal({ title, body, placeholder, action, onClose, onSubmit }: { title: string; body: string; placeholder: string; action: string; onClose: () => void; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <input className="input" style={{ width: '100%' }} autoFocus placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => (onSubmit(text), onClose())}>{action}</button>
        </div>
      </div>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private windows can refuse storage; preferences just won't persist.
  }
}
