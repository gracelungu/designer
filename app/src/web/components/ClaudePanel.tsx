import { useEffect, useState } from 'react';
import type { Capabilities, MemoryFile, SessionSummary } from '../../shared/protocol';
import { api, socket } from '../api';
import type { SessionState } from '../store';

/** Sessions to resume, plus what your Claude Code has loaded: commands, skills, MCP servers, memory. */
export function SessionsPanel({ session, onResume }: { session: SessionState; onResume: (id?: string) => void }) {
  const [list, setList] = useState<SessionSummary[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<SessionSummary[]>('/api/sessions').then(setList, (e: Error) => setError(e.message));
  }, [session.sessionId]);
  return (
    <div className="scroll">
      <div className="section-title">
        Sessions in this folder
        <button className="btn small" onClick={() => onResume(undefined)}>New chat</button>
      </div>
      {error && <div className="empty">{error}</div>}
      {list?.length === 0 && <div className="empty">No Claude Code sessions in this folder yet.</div>}
      {list?.map((s) => (
        <div key={s.sessionId} className="row" style={{ cursor: 'pointer', background: s.sessionId === session.sessionId ? 'var(--hover)' : undefined }} onClick={() => onResume(s.sessionId)}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
            <div className="faint">
              {new Date(s.lastModified).toLocaleString()} {s.gitBranch ? `· ${s.gitBranch}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ClaudePanel({ caps, onRefresh }: { caps?: Capabilities; onRefresh: () => void }) {
  const [memory, setMemory] = useState<MemoryFile[]>();
  const [editing, setEditing] = useState<MemoryFile>();
  useEffect(() => {
    api<MemoryFile[]>('/api/memory').then(setMemory, () => undefined);
  }, []);
  if (!caps) return <div className="empty">Loading what your Claude Code has set up…</div>;
  const skills = caps.commands.filter((c) => !c.builtin);
  const builtins = caps.commands.filter((c) => c.builtin);
  return (
    <div className="scroll">
      <div className="section-title">
        Claude Code {caps.claudeVersion}
        <button className="btn small" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="row muted">
        {String(caps.account.email ?? caps.account.organization ?? caps.account.apiKeySource ?? caps.account.tokenSource ?? 'Signed in')}
        {caps.account.subscriptionType ? ` · ${String(caps.account.subscriptionType)}` : ''}
      </div>

      <div className="section-title">MCP servers ({caps.mcpServers.length})</div>
      {caps.mcpServers.length === 0 && <div className="empty">No MCP servers configured.</div>}
      {caps.mcpServers.map((s) => (
        <div key={s.name} className="row">
          <span className={`status-dot ${s.status === 'connected' ? 'ok' : s.status === 'pending' ? 'wait' : 'bad'}`} />
          <div>
            <b>{s.name}</b> <span className="muted">{s.status}{s.toolCount ? ` · ${s.toolCount} tools` : ''}{s.scope ? ` · ${s.scope}` : ''}</span>
            {s.error && <div className="faint">{s.error}</div>}
          </div>
        </div>
      ))}

      <div className="section-title">Memory (CLAUDE.md)</div>
      {memory?.map((m) => (
        <div key={m.path} className="row" style={{ cursor: 'pointer' }} onClick={() => setEditing(m)}>
          <span className={`status-dot ${m.exists ? 'ok' : 'wait'}`} />
          <div style={{ minWidth: 0 }}>
            <b>{m.scope}</b> <span className="muted">{m.exists ? `${m.content.split('\n').length} lines` : 'not created'}</span>
            <div className="faint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.path}</div>
          </div>
        </div>
      ))}
      {editing && (
        <div style={{ padding: '0 12px 12px' }}>
          <textarea className="memory" value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              className="btn primary small"
              onClick={() => api<MemoryFile[]>('/api/memory', { path: editing.path, content: editing.content }).then((m) => (setMemory(m), setEditing(undefined)))}
            >
              Save memory
            </button>
            <button className="btn small" onClick={() => setEditing(undefined)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="section-title">Skills and custom commands ({skills.length})</div>
      {skills.map((c) => (
        <div key={c.name} className="row" title={c.description}>
          <div style={{ minWidth: 0 }}>
            <b>/{c.name}</b>
            <div className="faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</div>
          </div>
        </div>
      ))}
      <div className="section-title">Built-in commands ({builtins.length})</div>
      {builtins.map((c) => (
        <div key={c.name} className="row" title={c.description}>
          <b>/{c.name}</b> <span className="faint">{c.description}</span>
        </div>
      ))}
      <div className="section-title">Agents ({caps.agents.length})</div>
      {caps.agents.map((a) => (
        <div key={a.name} className="row">
          <b>{a.name}</b>
        </div>
      ))}
    </div>
  );
}

export function FigmaModal({ onClose, sessionRunning }: { onClose: () => void; sessionRunning: boolean }) {
  const [url, setUrl] = useState('http://127.0.0.1:3845/mcp');
  const [status, setStatus] = useState<{ reachable: boolean; status?: number }>();
  const [component, setComponent] = useState('');
  const send = (text: string) => {
    if (!sessionRunning) socket.send({ type: 'start' });
    socket.send({ type: 'connect-figma', url });
    socket.send({ type: 'prompt', text });
    onClose();
  };
  const check = () => api<{ reachable: boolean; status?: number }>(`/api/figma/status?url=${encodeURIComponent(url)}`).then(setStatus);
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Import from Figma</h3>
        <p>
          Select frames in the Figma desktop app, then import: Claude reads them through Figma's local MCP server and puts them on the canvas as editable layers, next to the matching components from your code. Turn the server on in Figma (Preferences → Enable Dev Mode MCP Server). No token needed.
        </p>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" onClick={check}>Check</button>
        </div>
        <p style={{ marginTop: 8 }}>
          <span className={`status-dot ${status?.reachable ? 'ok' : 'bad'}`} /> {status === undefined ? 'Checking…' : status.reachable ? 'Figma desktop MCP server is running.' : 'Not reachable. Is the Figma desktop app open with the MCP server enabled?'}
        </p>
        <h3 style={{ marginTop: 16 }}>Build a component that's not in code</h3>
        <p>Select the component set in Figma, name it here, and Claude builds it with every variant, a story and your tokens, then compares it with the design.</p>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Component name, e.g. PlanBadge" value={component} onChange={(e) => setComponent(e.target.value)} />
          <button
            className="btn"
            disabled={!status?.reachable || !component.trim()}
            onClick={() =>
              send(
                `Build the ${component.trim()} component from my current Figma selection (a component set), using the figma MCP server. Steps: 1) read its variants, properties, variables and a screenshot of each variant; 2) put the design on the Designer canvas with add_to_canvas so we can see it; 3) propose the component's props (map Figma properties to props) and the files you will add, following this repo's existing component conventions, and wait for my OK; 4) build it with every variant using our existing tokens (no raw values when a token exists); 5) add a Storybook story with one story per variant; 6) show_component next to the design (nextToSelection), link the design to it (update_layers with codeLink), and list any differences you see.`,
              )
            }
          >
            Build in code
          </button>
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
          <button
            className="btn primary"
            disabled={!status?.reachable}
            onClick={() =>
              send(
                'Use the figma MCP server to read my current Figma selection (metadata, design context and variables). Put it on the Designer canvas as editable layers with add_to_canvas, keeping real sizes, colours, text and auto layout. Where a part is one of our coded components, set codeLink on that layer and show_component next to the frame. Then tell me which components are not in our code yet. Do not change files yet.',
              )
            }
          >
            Import selection
          </button>
        </div>
      </div>
    </div>
  );
}
