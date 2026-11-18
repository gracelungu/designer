import { useEffect, useRef, useState } from 'react';
import { api, socket } from '../api';

interface FigmaFrame {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  children?: number;
}

interface FigmaStatus {
  state: 'connected' | 'not-running' | 'error';
  url: string;
  detail?: string;
  server?: string;
  tools?: string[];
  selection?: FigmaFrame[];
  pageName?: string;
}

const thumbs = new Map<string, Promise<string | null>>();
function thumb(id: string) {
  if (!thumbs.has(id)) thumbs.set(id, api<{ src: string | null }>(`/api/figma/thumb?id=${encodeURIComponent(id)}`).then((r) => r.src, () => null));
  return thumbs.get(id)!;
}

/** Figma links carry the node as `node-id=12-34`; the MCP server wants `12:34`. Also accepts a bare id. */
export function nodeIdFromLink(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const raw = u.searchParams.get('node-id');
    return raw ? decodeURIComponent(raw).replace(/-/g, ':') : null;
  } catch {
    return /^\d+[:-]\d+$/.test(t) ? t.replace('-', ':') : null;
  }
}

const KIND: Record<string, string> = {
  frame: 'Frame',
  section: 'Section',
  component: 'Component',
  'component-set': 'Component set',
  component_set: 'Component set',
  instance: 'Instance',
  group: 'Group',
  canvas: 'Page',
  text: 'Text',
};

/**
 * Import from Figma. Finds Figma's desktop MCP server on its own, lists what is selected in Figma
 * (refreshing as the selection changes) with thumbnails, and lets you pick what Claude brings in.
 */
export function FigmaImport({ onClose, sessionRunning }: { onClose: () => void; sessionRunning: boolean }) {
  const [status, setStatus] = useState<FigmaStatus>();
  const [checking, setChecking] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [linked, setLinked] = useState<FigmaFrame[]>([]);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [withCode, setWithCode] = useState(true);
  const urlRef = useRef('');
  urlRef.current = customUrl;

  const check = async () => {
    setChecking(true);
    try {
      const q = urlRef.current.trim() ? `?url=${encodeURIComponent(urlRef.current.trim())}` : '';
      const s = await api<FigmaStatus>(`/api/figma/status${q}`);
      setStatus(s);
    } catch (e) {
      setStatus({ state: 'error', url: '', detail: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };

  // Look again every few seconds: picks up Figma being opened, the server being turned on, or a new selection.
  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), 3000);
    return () => clearInterval(t);
  }, []);

  const items = [...(status?.selection ?? []), ...linked.filter((l) => !status?.selection?.some((s) => s.id === l.id))];
  const isOn = (id: string) => picked[id] !== false;
  const chosen = items.filter((i) => isOn(i.id));
  const connected = status?.state === 'connected';

  const send = (text: string) => {
    if (!sessionRunning) socket.send({ type: 'start' });
    socket.send({ type: 'connect-figma', url: status!.url });
    socket.send({ type: 'prompt', text });
    onClose();
  };

  const importChosen = () => {
    const list = chosen.map((c) => `"${c.name}" (nodeId ${c.id}, ${KIND[c.type] ?? c.type}${c.width ? `, ${c.width}×${c.height}` : ''})`).join('; ');
    send(
      `Import these Figma nodes onto the Designer canvas using the figma MCP server: ${list}. ` +
        'For each one, read it with its nodeId (design context, metadata and variables), then add it with add_to_canvas as editable layers, keeping real sizes, colours, fonts, text, radius, effects and auto layout, and place them side by side without overlapping what is already there. ' +
        (withCode
          ? 'Where a part is one of our coded components, set codeLink on that layer and show_component next to the frame so the design and the code can be compared. Then tell me which components are not in our code yet. '
          : '') +
        'Do not change any files yet.',
    );
  };

  const buildInCode = (c: FigmaFrame) =>
    send(
      `Build "${c.name}" (Figma nodeId ${c.id}) as a component in this repo, using the figma MCP server. Steps: 1) read its variants, properties, variables and a screenshot of each variant; 2) put the design on the Designer canvas with add_to_canvas so we can see it; 3) propose the component's props (map Figma properties to props) and the files you will add, following this repo's existing component conventions, and wait for my OK; 4) build it with every variant using our existing tokens (no raw values when a token exists); 5) add a Storybook story with one story per variant; 6) show_component next to the design, link the design to it (update_layers with codeLink), and list any differences you see.`,
    );

  const addLink = async () => {
    setLinkError('');
    const id = nodeIdFromLink(link);
    if (!id) return setLinkError('That link has no node-id. In Figma, right-click a frame → Copy link to selection.');
    try {
      const r = await api<{ nodes: FigmaFrame[]; pageName?: string }>(`/api/figma/node?id=${encodeURIComponent(id)}`);
      const node = r.nodes[0] ?? { id, name: r.pageName ?? `Node ${id}`, type: r.pageName ? 'canvas' : 'frame' };
      setLinked((l) => [...l.filter((x) => x.id !== node.id), { ...node, id }]);
      setLink('');
    } catch (e) {
      setLinkError(`Figma couldn't find that node. Is the link from the file that's open in Figma? (${(e as Error).message})`);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal figma-import" onClick={(e) => e.stopPropagation()}>
        <h3>Import from Figma</h3>

        <div className={`figma-status ${status?.state ?? 'checking'}`}>
          <span className={`status-dot ${connected ? 'ok' : status ? 'bad' : ''}`} />
          {!status && 'Looking for the Figma desktop app…'}
          {connected && (
            <span>
              Connected to Figma desktop{status.pageName ? <> · page <b>{status.pageName}</b></> : null}
            </span>
          )}
          {status?.state === 'not-running' && <span>Figma desktop isn't reachable yet</span>}
          {status?.state === 'error' && <span>Figma answered, but something went wrong</span>}
          {checking && <span className="faint figma-checking">checking…</span>}
        </div>

        {status && !connected && (
          <div className="figma-setup">
            <ol>
              <li>Open the <b>Figma desktop app</b> (not the browser) and open your design file.</li>
              <li>
                Turn on its MCP server: <b>Figma menu → Preferences → Enable Dev Mode MCP Server</b>. In newer versions it's in Dev Mode (<kbd>Shift</kbd> <kbd>D</kbd>) → Inspect panel → <b>Enable desktop MCP server</b>.
              </li>
              <li>Leave this window open. Designer checks again every few seconds.</li>
            </ol>
            {status.detail && status.state === 'error' && <p className="faint">{status.detail}</p>}
            <p className="faint">No token or sign-in needed: Figma's desktop server only runs on your computer. Dev Mode needs a paid Figma seat.</p>
          </div>
        )}

        {connected && (
          <>
            <div className="section-label">Selected in Figma</div>
            {items.length === 0 ? (
              <div className="figma-empty">
                Nothing selected. Click one or more frames, components or sections in Figma and they'll show up here.
                {status.detail && <div className="faint">{status.detail}</div>}
              </div>
            ) : (
              <div className="figma-grid">
                {items.map((it) => (
                  <FrameCard key={it.id} frame={it} on={isOn(it.id)} toggle={() => setPicked((p) => ({ ...p, [it.id]: !isOn(it.id) }))} />
                ))}
              </div>
            )}

            <div className="figma-link">
              <input
                className="input"
                placeholder="Or paste a Figma link to a frame or page"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addLink()}
              />
              <button className="btn small" disabled={!link.trim()} onClick={() => void addLink()}>
                Add
              </button>
            </div>
            {linkError && <p className="figma-error">{linkError}</p>}

            <label className="figma-opt">
              <input type="checkbox" checked={withCode} onChange={(e) => setWithCode(e.target.checked)} />
              Put the matching coded components next to the design
            </label>
          </>
        )}

        <button className="link-btn" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? 'Hide' : 'Server address'}
        </button>
        {advanced && (
          <div className="figma-link">
            <input className="input" placeholder="http://127.0.0.1:3845/mcp (found automatically)" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} />
            <button className="btn small" onClick={() => void check()}>
              Check
            </button>
          </div>
        )}

        <div className="actions">
          {connected && chosen.length === 1 && /component/.test(chosen[0].type) && (
            <button className="btn" onClick={() => buildInCode(chosen[0])} title="Claude builds it in code with every variant and a story">
              Build in code
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!connected || chosen.length === 0} onClick={importChosen}>
            {chosen.length > 1 ? `Import ${chosen.length} items` : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FrameCard({ frame, on, toggle }: { frame: FigmaFrame; on: boolean; toggle: () => void }) {
  const [src, setSrc] = useState<string | null>();
  useEffect(() => {
    let live = true;
    void thumb(frame.id).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [frame.id]);
  return (
    <button className={`figma-card ${on ? 'on' : ''}`} onClick={toggle} title={on ? 'Click to leave out' : 'Click to include'}>
      <div className="figma-thumb">{src ? <img src={src} alt="" /> : <span className="faint">{src === undefined ? 'Loading…' : 'No preview'}</span>}</div>
      <div className="figma-card-meta">
        <input type="checkbox" checked={on} readOnly tabIndex={-1} />
        <div>
          <div className="figma-card-name">{frame.name}</div>
          <div className="faint">
            {KIND[frame.type] ?? frame.type}
            {frame.width ? ` · ${frame.width}×${frame.height}` : ''}
          </div>
        </div>
      </div>
    </button>
  );
}
