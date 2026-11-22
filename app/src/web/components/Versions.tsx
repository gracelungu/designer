import { useCallback, useEffect, useState } from 'react';
import type { VersionEntry, VersionHistory } from '../../shared/protocol';
import { api, socket } from '../api';
import type { useTeamSync } from '../sync/team';

type Result = { ok: boolean; message: string };

function when(t: number) {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Display name for a variation: "design/dark-mode" -> "Dark mode"; the main one is "Main". */
export function variationLabel(name: string, main: string) {
  if (name === main) return 'Main';
  const last = name.replace(/^design\//, '');
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Version history the way Figma shows it: the current version on top, named versions as milestones,
 * every saved version below with Restore; and variations (branches) to try ideas on the side.
 */
export function VersionsPanel({ hasProject, onToast, onAsk, flushCanvas, team }: {
  hasProject: boolean;
  onToast: (t: { text: string; url?: string }) => void;
  onAsk: (p: string) => void;
  flushCanvas: () => Promise<void>;
  team: ReturnType<typeof useTeamSync>;
}) {
  const [h, setH] = useState<VersionHistory>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>();
  const [files, setFiles] = useState<Record<string, { status: string; path: string }[]>>({});
  const [naming, setNaming] = useState(false);
  const [newVariation, setNewVariation] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!hasProject) return;
    api<VersionHistory>('/api/versions').then(
      (x) => (setH(x), setError('')),
      (e: Error) => setError(e.message),
    );
  }, [hasProject]);
  useEffect(load, [load]);
  useEffect(() => { if (team.notice && !team.notice.error) load(); }, [team.notice, load]);
  // Anything that changes the project (a save, a turn by Claude, a sync) refreshes the list.
  useEffect(() => {
    const off = socket.on((m) => (m.type === 'project' || (m.type === 'item' && m.item.kind === 'result') ? load() : undefined));
    return () => void off();
  }, [load]);

  const act = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      if (path !== '/api/git/team/fetch') await flushCanvas();
      const r = await api<Result>(path, body);
      onToast({ text: r.message });
      load();
      return r;
    } catch (e) {
      onToast({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!hasProject) return <div className="empty">Add a project to see its version history.</div>;
  if (error)
    return (
      <div className="scroll">
        <div className="empty">{error}</div>
        <div className="row-actions" style={{ padding: 12 }}>
          <button className="btn small" onClick={() => onAsk('Start version history (git) in this project folder, with a sensible .gitignore, and save the current state as the first version.')}>Start version history</button>
        </div>
      </div>
    );
  if (!h) return <div className="empty">Loading history…</div>;

  const toggle = async (v: VersionEntry) => {
    setOpen(open === v.id ? undefined : v.id);
    if (!files[v.id]) setFiles({ ...files, [v.id]: await api<{ status: string; path: string }[]>(`/api/versions/files?id=${v.id}`).catch(() => []) });
  };

  return (
    <div className="scroll versions" data-canvas-keys="off">
      <div className="team-sync">
        <b>Team sync</b>
        <span className="muted">{team.status?.reason ?? 'Share canvas changes and comments on this branch through origin.'}</span>
        {team.status && !team.status.reason && (
          <>
            <label className="team-sync-toggle">
              <input type="checkbox" checked={team.auto} disabled={team.busy || busy} onChange={(e) => void team.configure(e.target.checked)} />
              Automatically sync this branch
            </label>
            <span className="faint">Runs while Designer is open. Incoming commits update the branch you have checked out.</span>
          </>
        )}
        <div className="row-actions">
          <button className="btn small" disabled={team.busy || busy || !h.remote} onClick={() => void act('/api/git/team/fetch', {})}>Refresh branches</button>
          <button className="btn small primary" disabled={team.busy || busy || !team.status || !!team.status.reason} onClick={() => void team.sync(false).then(load)}>
            {team.busy ? 'Working…' : 'Sync design now'}
          </button>
        </div>
        {team.notice && <span role="status" className={team.notice.error ? 'error-box' : 'muted'}>{team.notice.text}</span>}
      </div>
      <div className="section-title">
        <span>Variation</span>
        <button className="btn ghost small" onClick={() => setNewVariation('')} disabled={busy || team.busy}>+ New</button>
      </div>
      {newVariation !== undefined && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (newVariation.trim()) void act('/api/variations/create', { name: newVariation }).then(() => setNewVariation(undefined));
          }}
        >
          <input className="input" autoFocus placeholder="Name, e.g. Dark mode" value={newVariation} onChange={(e) => setNewVariation(e.target.value)} />
          <button className="btn small primary" type="submit">Create</button>
          <button className="btn small" type="button" onClick={() => setNewVariation(undefined)}>Cancel</button>
        </form>
      )}
      <div className="variations">
        {h.variations.map((v) => (
          <div key={v.name} className={`variation ${v.current ? 'on' : ''}`} data-testid="variation">
            <button className="variation-name" onClick={() => !v.current && void act('/api/variations/switch', { name: v.name })} disabled={busy || team.busy || v.current} title={v.current ? 'You are here' : `Open ${v.name}`}>
              <span className="dot-cur" aria-hidden="true" />
              <b>{variationLabel(v.name, h.main)}</b>
              {!v.shared && <span className="faint"> · only on this computer</span>}
              {v.remoteOnly && <span className="faint"> · team branch</span>}
            </button>
            {!v.current && !v.remoteOnly && (
              <span className="variation-actions">
                <button className="btn ghost small" onClick={() => void act('/api/variations/merge', { name: v.name })} disabled={busy} title={`Bring ${v.name}'s changes into what you're on`}>Merge in</button>
                {v.name !== h.main && (
                  <button className="btn ghost small" onClick={() => void act('/api/variations/delete', { name: v.name })} disabled={busy} aria-label={`Remove ${v.name}`}>
                    Remove
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="section-title">
        <span>Version history</span>
        {h.remote && (
          <button className="btn ghost small" onClick={() => void act('/api/git/sync', {})} disabled={busy} title="Commit all changes, including code, and sync this Git branch">
            Sync entire project {h.behind > 0 && <span className="badge dark">{h.behind}</span>}
          </button>
        )}
      </div>
      <div className="version current">
        <div className="version-dot" />
        <div className="version-body">
          <b>Current version</b>
          <span className="muted">{h.unsaved ? `${h.unsaved} unsaved change${h.unsaved === 1 ? '' : 's'}` : 'Everything is saved'}</span>
          {!naming ? (
            <button className="btn small" onClick={() => setNaming(true)} disabled={busy}>Add to version history…</button>
          ) : (
            <NameForm busy={busy} onCancel={() => setNaming(false)} onSave={(name, description) => void act('/api/versions/name', { name, description }).then((r) => r?.ok && setNaming(false))} />
          )}
        </div>
      </div>
      {h.versions.length === 0 && <div className="empty">No versions yet.</div>}
      {h.versions.map((v, idx) => (
        <div key={v.id} className={`version ${v.name ? 'named' : ''}`} data-testid="version">
          <div className="version-dot" />
          <div className="version-body">
            <button className="version-title" onClick={() => void toggle(v)}>
              <b>{v.name ?? v.title}</b>
              <span className="faint">
                {when(v.date)} · {v.author}
                {v.local && h.remote ? ' · not sent yet' : ''}
              </span>
              {v.name && v.name !== v.title && <span className="muted">{v.title}</span>}
              {v.description && <span className="muted">{v.description}</span>}
            </button>
            {open === v.id && (
              <div className="version-detail">
                <ul>
                  {(files[v.id] ?? []).slice(0, 12).map((f) => (
                    <li key={f.path} className="mono">
                      <span className="faint">{f.status}</span> {f.path}
                    </li>
                  ))}
                </ul>
                {idx > 0 || h.unsaved ? (
                  <button className="btn small" disabled={busy} onClick={() => void act('/api/versions/restore', { id: v.id })}>
                    Restore this version
                  </button>
                ) : (
                  <span className="faint">This is the latest version.</span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function NameForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (name: string, description: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="name-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name, description);
      }}
    >
      <input className="input" autoFocus placeholder="Title" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="input area" rows={2} placeholder="Describe what changed" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="row-actions">
        <button className="btn small" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn small primary" type="submit" disabled={busy || !name.trim()}>Save</button>
      </div>
    </form>
  );
}
