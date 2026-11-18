import { useEffect, useRef, useState } from 'react';

export interface Frame {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

const DEVICES = [
  { name: 'Desktop', width: 1280, height: 800 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Mobile', width: 390, height: 844 },
];

/** Live frames of the running app on a pannable, zoomable board. */
export function Canvas({
  appUrl,
  scripts,
  onRunApp,
  running,
  onAsk,
  reloadKey,
}: {
  appUrl?: string;
  scripts: Record<string, string>;
  onRunApp: () => void;
  running: boolean;
  onAsk: (context: string) => void;
  reloadKey: number;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState({ x: 40, y: 60, zoom: 0.5 });
  const [panning, setPanning] = useState(false);
  const [route, setRoute] = useState('/');
  const [manualUrl, setManualUrl] = useState('');
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appUrl) return;
    setFrames((fs) =>
      fs.length
        ? fs.map((f) => ({ ...f, url: appUrl + new URL(f.url).pathname }))
        : DEVICES.reduce<Frame[]>((acc, d) => {
            const x = acc.length ? acc[acc.length - 1].x + acc[acc.length - 1].width + 80 : 0;
            return [...acc, { id: d.name, name: `${d.name} · /`, url: `${appUrl}/`, width: d.width, height: d.height, x, y: 0 }];
          }, []),
    );
  }, [appUrl]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const zoom = Math.min(2, Math.max(0.1, v.zoom * (1 - e.deltaY * 0.01)));
          return { zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const addRoute = () => {
    if (!appUrl) return;
    const path = route.startsWith('/') ? route : `/${route}`;
    const maxY = Math.max(0, ...frames.map((f) => f.y + f.height));
    setFrames([...frames, { id: crypto.randomUUID(), name: `Desktop · ${path}`, url: appUrl + path, width: 1280, height: 800, x: 0, y: maxY + 120 }]);
  };

  const sel = frames.find((f) => f.id === selected);

  return (
    <div
      ref={ref}
      className={`canvas ${panning ? 'panning' : ''}`}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.frame, .canvas-toolbar, .card')) return;
        setSelected(undefined);
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        setPanning(true);
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onMouseUp={() => ((drag.current = null), setPanning(false))}
      onMouseLeave={() => ((drag.current = null), setPanning(false))}
    >
      {!appUrl ? (
        <div className="canvas-empty">
          <div className="card">
            <h2>See your product on the canvas</h2>
            <p>Designer runs your project's own dev server and shows each screen as a live frame. When Claude changes the code, the frames update.</p>
            <div className="actions">
              {scripts.dev ? (
                <button className="btn primary" onClick={onRunApp} disabled={running}>
                  {running ? 'Starting…' : 'Run app (npm run dev)'}
                </button>
              ) : (
                <span className="muted">This project has no "dev" script.</span>
              )}
            </div>
            <p style={{ marginTop: 12 }}>Or show an app that is already running:</p>
            <div className="actions">
              <input className="input" placeholder="http://localhost:3000" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
              <button className="btn" onClick={() => manualUrl && window.dispatchEvent(new CustomEvent('designer:app-url', { detail: manualUrl.replace(/\/$/, '') }))}>
                Show
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="canvas-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          {frames.map((f) => (
            <div key={f.id} className={`frame ${f.id === selected ? 'selected' : ''}`} style={{ left: f.x, top: f.y }}>
              <div className="frame-label" style={{ fontSize: 11 / view.zoom }} onMouseDown={() => setSelected(f.id)}>
                {f.name} <span className="faint">{f.width}×{f.height}</span>
              </div>
              <div className="frame-body" style={{ width: f.width, height: f.height, position: 'relative' }}>
                <iframe key={reloadKey} title={f.name} src={f.url} width={f.width} height={f.height} />
                {f.id !== selected && <div className="shield" onMouseDown={() => setSelected(f.id)} />}
              </div>
            </div>
          ))}
        </div>
      )}
      {appUrl && (
        <div className="canvas-toolbar">
          <input className="input" style={{ width: 120 }} value={route} onChange={(e) => setRoute(e.target.value)} aria-label="Route" />
          <button className="btn small" onClick={addRoute}>Add page</button>
          <span className="muted" style={{ padding: '0 6px' }}>{Math.round(view.zoom * 100)}%</span>
          <button className="btn small" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.1, v.zoom / 1.25) }))}>−</button>
          <button className="btn small" onClick={() => setView((v) => ({ ...v, zoom: Math.min(2, v.zoom * 1.25) }))}>+</button>
          {sel && (
            <button className="btn primary small" onClick={() => onAsk(`Context: the designer is looking at the ${sel.name} frame (${sel.url}, ${sel.width}px wide) of the running app.`)}>
              Ask Claude about this frame
            </button>
          )}
        </div>
      )}
    </div>
  );
}
