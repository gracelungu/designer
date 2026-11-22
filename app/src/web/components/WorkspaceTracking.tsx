import { useEffect, useState } from 'react';
import type { WorkspaceTracking as TrackingInfo } from '../../shared/protocol';
import { api } from '../api';

export function WorkspaceTracking({ project, branch, disabled, automatic, revision, onSaved }: {
  project: string;
  branch: string;
  disabled: boolean;
  automatic: boolean;
  revision?: string;
  onSaved: () => void;
}) {
  const [info, setInfo] = useState<TrackingInfo>();
  const [name, setName] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void api<TrackingInfo>('/api/git/workspace').then((next) => {
      if (current) setInfo(next);
    }).catch((failure: Error) => {
      if (current) setError(failure.message);
    });
    return () => { current = false; };
  }, [project, branch, revision]);

  const save = async (label: string) => {
    if (!info || disabled || saving) return;
    setSaving(true);
    setError('');
    try {
      setInfo(await api<TrackingInfo>('/api/git/workspace', { project, branch, name: label, id: info.manifest?.id ?? null }));
      setName(undefined);
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const manifest = info?.manifest;
  return (
    <details className="team-sync workspace-tracking">
      <summary>Shared workspace</summary>
      {!info && !error && <p className="muted">Checking workspace…</p>}
      {info?.reason ? <p className="muted">{info.reason}</p> : info && (
        <>
          <p className="muted">{manifest
            ? `${manifest.name} · ${info.pending && info.tracked ? 'Changes waiting for a commit' : info.tracked ? 'Tracked in Git' : 'Local manifest'}`
            : 'Set up shared project metadata so teammates can recognize and manage this workspace.'}</p>
          <code>.designer/workspace.json</code>
          {manifest && (
            <p className="faint">Canvas {info.canvasTracked ? 'tracked' : 'pending first Git save'} · {info.commentThreads} tracked comment {info.commentThreads === 1 ? 'thread' : 'threads'}</p>
          )}
          {name !== undefined ? (
            <form className="name-form" onSubmit={(event) => {
              event.preventDefault();
              void save(name);
            }}>
              <label>
                Workspace name
                <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
              </label>
              <p className="faint">Designer stages the manifest. {automatic ? 'Your automatic sync can publish it on this branch.' : 'Share it through Team sync or commit it for review.'}</p>
              <div className="row-actions">
                <button className="btn small primary" disabled={disabled || saving || !name.trim()}>{manifest ? 'Save workspace name' : 'Create and track workspace'}</button>
                <button type="button" className="btn small" disabled={saving} onClick={() => setName(undefined)}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="row-actions">
              <button className="btn small" disabled={disabled || saving} onClick={() => setName(manifest?.name ?? info.defaultName)}>
                {manifest ? 'Edit workspace name' : 'Set up shared workspace'}
              </button>
              {manifest && !info.tracked && (
                <button className="btn small" disabled={disabled || saving} onClick={() => void save(manifest.name)}>Track existing workspace</button>
              )}
            </div>
          )}
        </>
      )}
      {error && <p className="error-box" role="alert">{error}</p>}
    </details>
  );
}
