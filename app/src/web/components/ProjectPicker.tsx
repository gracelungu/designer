import { useEffect, useState } from 'react';
import { api } from '../api';

interface Listing {
  path: string;
  parent: string | null;
  dirs: string[];
  isRepo: boolean;
  sep: string;
}

/** Choose the repository folder Claude Code will work in. */
export function ProjectPicker({ home, current, onOpen, onCancel }: { home: string; current?: string; onOpen: (path: string) => Promise<void>; onCancel?: () => void }) {
  const [dir, setDir] = useState<Listing>();
  const [error, setError] = useState('');
  const go = (path: string) => api<Listing>(`/api/fs?path=${encodeURIComponent(path)}`).then(setDir, (e: Error) => setError(e.message));
  useEffect(() => {
    void go(current ?? home);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = (p: string) => onOpen(p).catch((e: Error) => setError(e.message));
  return (
    <div className="modal picker" data-canvas-keys="off">
      <div>
        <h3>Add a project</h3>
        <p>Pick your repository's folder. The canvas, components and Save version work on it, and Claude works in it. You can also just mention a project in the chat.</p>
        {window.designerNative && (
          <div className="actions" style={{ marginBottom: 10 }}>
            <button className="btn primary" onClick={async () => {
              const p = await window.designerNative!.pickFolder();
              if (p) await open(p);
            }}>Choose folder…</button>
          </div>
        )}
        {dir && (
          <>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{dir.path}</div>
            <div className="folder-list">
              {dir.parent && <button onClick={() => go(dir.parent!)}>↑ ..</button>}
              {dir.dirs.map((d) => (
                <button key={d} onClick={() => go(dir.path + dir.sep + d)} onDoubleClick={() => open(dir.path + dir.sep + d)}>📁 {d}</button>
              ))}
            </div>
            <div className="actions">
              <button className="btn primary" onClick={() => open(dir.path)}>Open {dir.isRepo ? 'this repository' : 'this folder'}</button>
              {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
            </div>
          </>
        )}
        {error && <p className="error-box" style={{ marginTop: 10 }}>{error}</p>}
      </div>
    </div>
  );
}
