import { useEffect, useState } from 'react';
import { api } from '../api';

interface Listing {
  path: string;
  parent: string | null;
  dirs: string[];
  sep: string;
}

/** Choose a folder to open in Designer. */
export function ProjectPicker({ home, current, onOpen, onCancel, onDemo }: { home: string; current?: string; onOpen: (path: string) => Promise<void>; onCancel?: () => void; onDemo?: () => Promise<void> }) {
  const [dir, setDir] = useState<Listing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('');
  const go = (path: string) => {
    setError('');
    return api<Listing>(`/api/fs?path=${encodeURIComponent(path)}`).then(setDir, (e: Error) => setError(e.message));
  };
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
        <p>Choose the folder that contains your project.</p>
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
        {dir && (
          <>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{dir.path}</div>
            <div className="folder-list">
              {dir.parent && <button disabled={busy} onClick={() => void go(dir.parent!)}>↑ ..</button>}
              {dir.dirs.map((d) => (
                <button key={d} disabled={busy} onClick={() => void go(dir.path + dir.sep + d)}>📁 {d}</button>
              ))}
            </div>
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={() => void open(() => onOpen(dir.path))}>{busy ? 'Scanning project files…' : 'Open this folder'}</button>
              {onCancel && <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>}
            </div>
          </>
        )}
        <details className="picker-path">
          <summary>Enter a folder path</summary>
          <form className="component-controls" onSubmit={(event) => {
            event.preventDefault();
            void open(() => onOpen(path.trim()));
          }}>
            <input className="input" placeholder="Paste a folder path" aria-label="Project folder path" value={path} onChange={(event) => setPath(event.target.value)} />
            <button className="btn" disabled={busy || !path.trim()}>Open path</button>
          </form>
        </details>
        {error && <p className="error-box" style={{ marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
