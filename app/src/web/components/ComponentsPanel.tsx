import { useState } from 'react';
import type { ProjectInfo } from '../../shared/protocol';

/** The repo's components, from its stories. Clicking one puts it on the canvas, rendered live from code. */
export function ComponentsPanel({
  project,
  storybookRunning,
  onPlace,
  onAsk,
  onAddProject,
}: {
  project: ProjectInfo | null;
  storybookRunning: boolean;
  onPlace: (storyId: string) => Promise<void>;
  onAsk: (prompt: string) => void;
  onAddProject: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!project)
    return (
      <div className="empty">
        Add a project to see its components here.
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={onAddProject}>Add project</button>
        </div>
      </div>
    );
  const list = project.stories.filter((e) => !filter || e.title.toLowerCase().includes(filter.toLowerCase()));
  if (!project.stories.length)
    return (
      <div className="empty">
        No component stories in this repo yet. Designer renders each component on the canvas from its story.
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => onAsk('Find the main reusable UI components in this repo and write a Storybook story file (CSF3) for each one, with one story per meaningful variant. Set Storybook up first if the repo does not have it, following the repo’s tooling. Then show the Button (or the most used component) on the canvas.')}>
            Ask Claude to set up components
          </button>
        </div>
      </div>
    );
  const place = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await onPlace(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="scroll components-panel">
      <div style={{ padding: '10px 12px 6px' }}>
        <input className="input" style={{ width: '100%' }} placeholder="Search components" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {!storybookRunning && <div className="hint">Click a component to place it on the canvas. Its story renders it live from your code.</div>}
      {error && <div className="error-box" style={{ margin: '0 12px 8px' }}>{error}</div>}
      {list.map((e) => {
        const name = e.title.split('/').pop()!;
        const group = e.title.includes('/') ? e.title.split('/').slice(0, -1).join(' / ') : '';
        const isOpen = open[e.file] ?? list.length <= 6;
        return (
          <div key={e.file} className="comp-entry">
            <button className="comp-head" onClick={() => setOpen({ ...open, [e.file]: !isOpen })}>
              <svg className={`chev ${isOpen ? 'open' : ''}`} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 1.5l3 2.5-3 2.5z" fill="currentColor" /></svg>
              <span className="code-glyph">{'</>'}</span>
              <span className="comp-name">{name}</span>
              {group && <span className="faint">{group}</span>}
            </button>
            {isOpen &&
              e.stories.map((s) => (
                <button key={s.id} className="comp-story" onClick={() => void place(s.id)} disabled={!!busy} title={`Place ${name} / ${s.name} on the canvas`}>
                  <span>{s.name}</span>
                  <span className="faint">{busy === s.id ? (storybookRunning ? 'Placing…' : 'Starting Storybook…') : 'Place'}</span>
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
