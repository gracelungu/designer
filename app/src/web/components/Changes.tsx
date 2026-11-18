import { useMemo, useState } from 'react';
import type { FileChange, GitStatus } from '../../shared/protocol';
import { api } from '../api';
import { collapse, lineDiff } from '../diff';

/** Before/after review of what Claude changed this session, plus uncommitted files from git. */
export function Changes({ changes, git }: { changes: FileChange[]; git?: GitStatus }) {
  // Several edits to one file collapse into one entry: first "before", last "after".
  const byFile = useMemo(() => {
    const map = new Map<string, FileChange>();
    for (const c of changes) {
      const prev = map.get(c.path);
      map.set(c.path, prev ? { ...c, before: prev.before } : c);
    }
    return [...map.values()];
  }, [changes]);
  const others = (git?.changed ?? []).filter((c) => !byFile.some((f) => f.path === c.path));

  return (
    <div className="scroll">
      <div className="section-title">Changed by Claude this session</div>
      {byFile.length === 0 && <div className="empty">When Claude edits a file, it shows up here with Before and After.</div>}
      {byFile.map((c) => (
        <FileDiff key={c.path} path={c.path} before={c.before} after={c.after} />
      ))}
      <div className="section-title">Not saved as a version yet</div>
      {others.length === 0 && byFile.length === 0 && <div className="empty">Everything is saved.</div>}
      {others.map((c) => (
        <GitFile key={c.path} path={c.path} status={c.status} />
      ))}
    </div>
  );
}

function GitFile({ path, status }: { path: string; status: string }) {
  const [diff, setDiff] = useState<{ before: string; after: string }>();
  return diff ? (
    <FileDiff path={path} before={diff.before} after={diff.after} />
  ) : (
    <div className="row" style={{ cursor: 'pointer' }} onClick={() => api<{ before: string; after: string }>(`/api/diff?path=${encodeURIComponent(path)}`).then(setDiff)}>
      <span className="mono faint" style={{ width: 14 }}>{status}</span>
      <span>{path}</span>
    </div>
  );
}

export function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const [view, setView] = useState<'diff' | 'split'>('diff');
  const [open, setOpen] = useState(true);
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const adds = lines.filter((l) => l.type === 'add').length;
  const dels = lines.filter((l) => l.type === 'del').length;
  return (
    <div className="file-change">
      <header>
        <button className="btn ghost small" onClick={() => setOpen(!open)} style={{ fontWeight: 600 }}>
          {path}
        </button>
        <span className="mono">
          <span style={{ color: 'var(--add-text)' }}>+{adds}</span> <span style={{ color: 'var(--del-text)' }}>−{dels}</span>
        </span>
        <div className="segmented">
          <button className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>Changes</button>
          <button className={view === 'split' ? 'on' : ''} onClick={() => setView('split')}>Before / After</button>
        </div>
      </header>
      {open &&
        (view === 'diff' ? (
          <div className="diff">
            {collapse(lines).map((l, i) =>
              l.type === 'gap' ? (
                <div key={i} className="gap">⋯ {l.count} unchanged lines</div>
              ) : (
                <div key={i} className={l.type}>
                  {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
                  {l.text}
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="diff side-by-side">
            <div>
              <h5>Before</h5>
              {(before || '(new file)').split('\n').map((t, i) => (
                <div key={i}>{t}</div>
              ))}
            </div>
            <div>
              <h5>After</h5>
              {(after || '(deleted)').split('\n').map((t, i) => (
                <div key={i}>{t}</div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
