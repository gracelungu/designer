import { useState, useSyncExternalStore } from 'react';
import type { DesignChange, LayerSync, ProposalScope, SyncJob } from '../../shared/protocol';
import type { SyncController } from '../sync/controller';
import { syncOf } from '../sync/model';
import { reviewImage } from '../api';
import { FileDiff } from './Changes';
import { ReviewViewer } from './VisualReview';

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
  if (running) text = 'Preparing a code proposal…';
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

const scopes: Record<ProposalScope, string> = {
  example: 'This example',
  component: 'Component default',
  token: 'Shared token',
};

const defaultScope = (l: LayerSync) => (l.kind === 'component' ? 'example' : 'component') as ProposalScope;

function targetImage(svg?: string) {
  if (svg) {
    try { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; } catch { /* malformed Unicode */ }
  }
}

function ProposalEvidence({ job, busy, onVerify }: { job: SyncJob; busy: boolean; onVerify: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const target = targetImage(job.targetSvg);
  const commands = job.plan && [...job.plan.prepare, ...(job.plan.preview ? [job.plan.preview] : []), ...job.plan.checks];
  return (
    <>
      {job.layers.map((l) => (
        <div key={l.layerId} className="proposal-intent">
          <b>{l.name} · {scopes[l.scope ?? defaultScope(l)]}{l.token ? ` · ${l.token}` : ''}</b>
          <ChangeList changes={l.changes} />
        </div>
      ))}
      {target && (
        <figure className="proposal-image">
          <figcaption>Design target</figcaption>
          <img alt="Canvas design target at proposal time" src={target} />
        </figure>
      )}
      {!!job.references?.length && (
        <details>
          <summary>Possible affected source references ({job.references.length})</summary>
          <p className="faint">Text matches in tracked files. Runtime usage may differ.</p>
          <ul>{job.references.map((path) => <li className="mono" key={path}>{path}</li>)}</ul>
        </details>
      )}
      {!!commands?.length && (
        <details className="proposal-plan" open>
          <summary>Project commands</summary>
          <p className="faint">Review the commands before running them. They execute locally in temporary copies of this project.</p>
          <ul>{commands.map((c, i) => <li className="mono" key={i}>{c.cwd} · {c.command}</li>)}</ul>
          {job.plan?.preview && <p className="faint">Preview routes: {job.plan.routes.join(', ')}</p>}
          <button className="btn small" disabled={busy || job.verifying} onClick={onVerify}>
            {job.verifying ? 'Running preview and checks…' : job.evidence ? 'Run again' : 'Run preview and checks'}
          </button>
        </details>
      )}
      {!job.evidence && !job.verifying && (
        <p className="faint">{commands?.length ? 'Preview and checks have not been run.' : 'The agent did not find project commands. Review the diff manually.'}</p>
      )}
      {job.evidence && (
        <>
          {job.evidence.note && <p className="faint">{job.evidence.note}</p>}
          {job.evidence.shots.some((shot) => shot.before || shot.after) && (
            <button type="button" className="btn small" onClick={() => setExpanded(true)}>Open visual comparison</button>
          )}
          {expanded && <ReviewViewer review={job.evidence} onClose={() => setExpanded(false)} transient />}
          {job.evidence.proposal?.checks.map((check, i) => (
            <details key={i}>
              <summary>{check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Skipped'} · <code>{check.command}</code></summary>
              {check.detail && <pre className="proposal-output">{check.detail}</pre>}
            </details>
          ))}
          {job.evidence.shots.map((shot) => (
            <div key={shot.key}>
              <b className="mono">{shot.label}</b>
              <div className="proposal-comparison">
                {(['before', 'after'] as const).map((phase) => {
                  const file = shot[phase];
                  return file && <figure key={phase} className="proposal-image">
                    <figcaption>{phase === 'before' ? 'Current code' : 'Proposed code'}</figcaption>
                    <img alt={`${shot.label} ${phase}`} src={reviewImage(job.id, file, String(job.evidence?.createdAt ?? ''))} />
                  </figure>;
                })}
              </div>
              {shot.error && <p className="faint">{shot.error}</p>}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** Design ↔ code: canvas edits to send, code changes to review, and code updates that reached the canvas. */
export function SyncPanel({ sync, agentReady, onClose, onSelect }: { sync: SyncController; agentReady: boolean; onClose: () => void; onSelect: (id: string) => void }) {
  const { pending, active, incoming, updates, checking } = useSync(sync);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedScopes, setSelectedScopes] = useState<Record<string, { scope: ProposalScope; token?: string }>>({});
  const scopeReady = (l: LayerSync) => selectedScopes[l.layerId]?.scope !== 'token' || !!selectedScopes[l.layerId]?.token?.trim();
  const [copied, setCopied] = useState('');
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
  const copy = async (layer: LayerSync) => {
    const target = [layer.file, layer.exportName, layer.storyId].filter(Boolean).join(' · ');
    const changes = layer.changes.map((c) => `- ${c.label}: ${show(c.from)} → ${show(c.to)}${c.css ? ` (${c.css})` : ''}`);
    const chosen = selectedScopes[layer.layerId];
    const scope = scopes[chosen?.scope ?? defaultScope(layer)];
    await navigator.clipboard.writeText([`${scope}: ${layer.name}${chosen?.token ? ` · ${chosen.token}` : ''}`, target, '', ...changes].join('\n'));
    setCopied(layer.layerId);
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
                <span className="toast-spin" /> Preparing a code proposal
              </div>
              <div className="faint">{job.layers.map((l) => l.name).join(', ')}</div>
              {job.progress.slice(-3).map((p, i) => (
                <div key={i} className="faint mono">{p}</div>
              ))}
            </>
          ) : (
            <>
              <div className="sync-card-head">Review the proposed diff</div>
              <ProposalEvidence job={job} busy={busy} onVerify={() => void act(() => sync.verify(job.id))} />
              {job.summary && <div className="sync-summary">{job.summary}</div>}
              {job.files.map((f) => (
                <FileDiff key={f.path} path={f.path} before={f.before ?? ''} after={f.after} />
              ))}
              <div className="cp-actions">
                <button className="btn primary" disabled={busy || job.verifying} onClick={() => act(() => sync.keep(job.id))}>Apply to checkout</button>
                <button className="btn" disabled={busy || job.verifying} onClick={() => act(() => sync.discard(job.id))}>Discard proposal</button>
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
        Canvas edits
        {agentReady && pending.length > 1 && (
          <button className="btn small primary" disabled={running || busy || !pending.every(scopeReady)} onClick={() => act(() => sync.sendToCode(undefined, selectedScopes))}>Propose all</button>
        )}
      </div>
      {pending.length === 0 && <div className="empty">Edits to linked layers appear here. Copy the changes for implementation or review a proposed diff.</div>}
      {pending.map((l) => (
        <div key={l.layerId} className="sync-card" data-testid="sync-pending">
          <button className="sync-layer" onClick={() => onSelect(l.layerId)}>
            {l.name} <span className="faint mono">{l.file ?? l.storyId}</span>
          </button>
          <label className="field">
            <span>Change scope</span>
            <select className="input" value={selectedScopes[l.layerId]?.scope ?? defaultScope(l)}
              onChange={(e) => setSelectedScopes((all) => ({ ...all, [l.layerId]: { scope: e.target.value as ProposalScope, token: all[l.layerId]?.token } }))}>
              {Object.entries(scopes).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
            </select>
          </label>
          {selectedScopes[l.layerId]?.scope === 'token' && (
            <label className="field"><span>Token name</span><input className="input" maxLength={120} value={selectedScopes[l.layerId]?.token ?? ''}
              onChange={(e) => setSelectedScopes((all) => ({ ...all, [l.layerId]: { scope: 'token', token: e.target.value } }))} /></label>
          )}
          <ChangeList changes={l.changes} />
          <div className="cp-actions">
            {agentReady && <button className="btn primary" disabled={running || busy || !scopeReady(l)} onClick={() => act(() => sync.sendToCode([l.layerId], selectedScopes))}>Propose code change</button>}
            <button className="btn" disabled={busy} onClick={() => act(() => copy(l))}>{copied === l.layerId ? 'Copied' : 'Copy changes'}</button>
            {l.kind === 'design' && <button className="btn ghost" onClick={() => sync.markImplemented(l)}>Mark implemented</button>}
            <button className="btn ghost" onClick={() => sync.revert(l.layerId)}>{l.kind === 'component' ? 'Reset overrides' : 'Revert design'}</button>
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
          {j.status === 'failed' ? `Couldn't change the code: ${j.error}` : j.status === 'kept' ? `Kept: ${j.files.map((f) => f.path).join(', ')}` : 'Discarded proposal' }
        </div>
      ))}
    </div>
  );
}
