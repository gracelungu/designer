import { useState, useSyncExternalStore } from 'react';
import type { DesignChange } from '../../shared/protocol';
import type { SyncController } from '../sync/controller';
import { syncOf } from '../sync/model';
import { FileDiff } from './Changes';

export function useSync(sync: SyncController) {
  useSyncExternalStore(
    (fn) => sync.on(fn),
    sync.snapshotVersion,
  );
  // Read fresh each render: pending edits come from the canvas itself.
  const active = sync.active();
  const inJob = new Set(active.flatMap((j) => j.layers.map((l) => l.layerId)));
  return { pending: sync.pending().filter((l) => !inJob.has(l.layerId)), active, incoming: sync.incoming(), updates: sync.updates, checking: sync.checking };
}

const show = (v: unknown) => {
  if (v === null || v === undefined || v === '') return 'none';
  if (Array.isArray(v)) return v.join(' ');
  return typeof v === 'string' ? v : JSON.stringify(v);
};

function Value({ v }: { v: unknown }) {
  const s = show(v);
  const color = typeof v === 'string' && /^#[0-9A-F]{6}/i.test(v);
  return (
    <span className="sync-val">
      {color && <span className="swatch" style={{ background: v as string }} />}
      <span className="mono">{s}</span>
    </span>
  );
}

function ChangeList({ changes }: { changes: DesignChange[] }) {
  return (
    <ul className="sync-changes">
      {changes.map((c) => (
        <li key={c.prop}>
          <span className="sync-label">{c.label}</span>
          <span className="sync-move">
            <Value v={c.from} /> <span className="faint">→</span> <Value v={c.to} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Small bar on the canvas: how many linked layers differ from the code, and what's waiting. */
export function SyncBar({ sync, onOpen }: { sync: SyncController; onOpen: () => void }) {
  const { pending, active, incoming, checking } = useSync(sync);
  const running = active.find((j) => j.status === 'running');
  const review = active.filter((j) => j.status === 'review').length;
  let text = '';
  if (running) text = 'Claude is turning your canvas edits into code…';
  else if (checking) text = 'Checking the canvas against the new code…';
  else if (review) text = `${review === 1 ? 'A code change is' : `${review} code changes are`} ready to review`;
  else if (incoming.length) text = `Code changed under ${incoming.length === 1 ? 'a layer you edited' : `${incoming.length} layers you edited`}`;
  else if (pending.length) text = `${pending.length === 1 ? '1 layer has' : `${pending.length} layers have`} edits that aren't in code yet`;
  if (!text) return null;
  return (
    <button className={`sync-bar ${running || checking ? 'busy' : ''}`} onClick={onOpen} data-testid="sync-bar">
      {(running || checking) && <span className="toast-spin" />}
      <span>{text}</span>
      <b>Review</b>
    </button>
  );
}

/** Design ↔ code: canvas edits to send, code changes to review, and code updates that reached the canvas. */
export function SyncPanel({ sync, onClose, onSelect }: { sync: SyncController; onClose: () => void; onSelect: (id: string) => void }) {
  const { pending, active, incoming, updates, checking } = useSync(sync);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = active.some((j) => j.status === 'running');
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recent = [...sync.jobs.values()].filter((j) => j.status === 'failed' || j.status === 'kept' || j.status === 'discarded').sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);

  return (
    <div className="scroll sync-panel" data-canvas-keys="off" data-testid="sync-panel">
      <div className="chat-head">
        <span className="chat-title">Design ↔ Code</span>
        <span className="grow" />
        <button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {error && <div className="error-box" style={{ margin: 8 }}>{error}</div>}

      {active.map((job) => (
        <div key={job.id} className="sync-card" data-testid={`sync-job-${job.status}`}>
          {job.status === 'running' ? (
            <>
              <div className="sync-card-head">
                <span className="toast-spin" /> Claude is changing the code
              </div>
              <div className="faint">{job.layers.map((l) => l.name).join(', ')}</div>
              {job.progress.slice(-3).map((p, i) => (
                <div key={i} className="faint mono">{p}</div>
              ))}
            </>
          ) : (
            <>
              <div className="sync-card-head">Review the code change</div>
              {job.summary && <div className="sync-summary">{job.summary}</div>}
              {job.files.map((f) => (
                <FileDiff key={f.path} path={f.path} before={f.before ?? ''} after={f.after} />
              ))}
              <div className="cp-actions">
                <button className="btn primary" disabled={busy} onClick={() => act(() => sync.keep(job.id))}>Keep</button>
                <button className="btn" disabled={busy} onClick={() => act(() => sync.discard(job.id))}>Discard</button>
              </div>
            </>
          )}
        </div>
      ))}

      {incoming.length > 0 && (
        <>
          <div className="section-title">Code changed where you edited too</div>
          {incoming.map((n) => (
            <div key={n.id} className="sync-card" data-testid="sync-incoming">
              <button className="sync-layer" onClick={() => onSelect(n.id)}>{n.name}</button>
              <ul className="sync-changes">
                {syncOf(n).incoming!.changes.map((c) => (
                  <li key={c.prop}>
                    <span className="sync-label">{c.label}</span>
                    <span className="sync-move">
                      <span className="faint">yours</span> <Value v={c.mine} /> <span className="faint">code</span> <Value v={c.code} />
                    </span>
                  </li>
                ))}
              </ul>
              <div className="cp-actions">
                <button className="btn primary" onClick={() => sync.resolve(n.id, 'code')}>Use code</button>
                <button className="btn" onClick={() => sync.resolve(n.id, 'design')}>Keep my design</button>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="section-title">
        Canvas edits not in code yet
        {pending.length > 1 && (
          <button className="btn small primary" disabled={running || busy} onClick={() => act(() => sync.sendToCode())}>Send all to code</button>
        )}
      </div>
      {pending.length === 0 && <div className="empty">Layers linked to code match it. Edit one on the canvas and it shows up here.</div>}
      {pending.map((l) => (
        <div key={l.layerId} className="sync-card" data-testid="sync-pending">
          <button className="sync-layer" onClick={() => onSelect(l.layerId)}>
            {l.name} <span className="faint mono">{l.file ?? l.storyId}</span>
          </button>
          <ChangeList changes={l.changes} />
          <div className="cp-actions">
            <button className="btn primary" disabled={running || busy} onClick={() => act(() => sync.sendToCode([l.layerId]))}>Send to code</button>
            <button className="btn" onClick={() => sync.revert(l.layerId)}>Revert design</button>
          </div>
        </div>
      ))}

      <div className="section-title">From code</div>
      {checking && <div className="empty">Checking linked layers against the new code…</div>}
      {!checking && updates.length === 0 && <div className="empty">When you Get latest (or the code changes in a commit), linked layers follow it here.</div>}
      {updates.map((u) => (
        <div key={u.id} className="sync-card" data-testid="sync-update">
          <button className="sync-layer" onClick={() => onSelect(u.layerId)}>{u.name}</button>
          {u.error ? <div className="faint">Couldn't check it: {u.error}</div> : u.applied.length ? <ChangeList changes={u.applied} /> : <div className="faint">Waiting for your decision above.</div>}
          {u.files.length > 0 && <div className="faint mono">{u.files.join(', ')}</div>}
        </div>
      ))}

      {recent.length > 0 && <div className="section-title">Earlier</div>}
      {recent.map((j) => (
        <div key={j.id} className="row faint" data-testid={`sync-job-${j.status}`}>
          {j.status === 'failed' ? `Couldn't change the code: ${j.error}` : j.status === 'kept' ? `Kept: ${j.files.map((f) => f.path).join(', ')}` : `Discarded${j.skipped?.length ? ` (left ${j.skipped.join(', ')} alone, it changed again)` : ''}`}
        </div>
      ))}
    </div>
  );
}
