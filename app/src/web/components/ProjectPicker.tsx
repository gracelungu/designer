import { useEffect, useState } from 'react';
import { api } from '../api';

interface Listing {
  path: string;
  parent: string | null;
  dirs: string[];
  isRepo: boolean;
  sep: string;
}

/** Choose a folder to open in Designer. */
export function ProjectPicker({ home, current, onOpen, onCancel, onDemo }: { home: string; current?: string; onOpen: (path: string) => Promise<void>; onCancel?: () => void; onDemo?: () => Promise<void> }) {
  const [dir, setDir] = useState<Listing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('');
  const go = (path: string) => api<Listing>(`/api/fs?path=${encodeURIComponent(path)}`).then(setDir, (e: Error) => setError(e.message));
  useEffect(() => {
    void go(current ?? home);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal picker" data-canvas-keys="off">
      <div>
        <h3>Open a project</h3>
        <p>Choose a local folder to browse its components and open its canvas.</p>
        {(window.designerNative || onDemo) && (
          <div className="actions" style={{ marginBottom: 10, justifyContent: 'flex-start' }}>
            {window.designerNative && (
              <button className="btn primary" disabled={busy} onClick={() => void open(async () => {
                const p = await window.designerNative!.pickFolder();
                if (p) await onOpen(p);
              })}>Choose folder…</button>
            )}
            {onDemo && <button className="btn" disabled={busy} onClick={() => void open(onDemo)}>Open the demo project</button>}
          </div>
        )}
        <form className="component-controls" onSubmit={(event) => {
          event.preventDefault();
          void open(() => onOpen(path.trim()));
        }}>
          <input className="input" placeholder="Paste a folder path" aria-label="Project folder path" value={path} onChange={(event) => setPath(event.target.value)} />
          <button className="btn" disabled={busy || !path.trim()}>Open path</button>
        </form>
        {dir && (
          <>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{dir.path}</div>
            <div className="folder-list">
              {dir.parent && <button onClick={() => go(dir.parent!)}>↑ ..</button>}
              {dir.dirs.map((d) => (
                <button key={d} onClick={() => go(dir.path + dir.sep + d)}>📁 {d}</button>
              ))}
            </div>
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={() => void open(() => onOpen(dir.path))}>{busy ? 'Opening…' : dir.isRepo ? 'Open this repository' : 'Open this folder'}</button>
              {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
            </div>
          </>
        )}
        {error && <p className="error-box" style={{ marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
