import { useState } from 'react';
import { componentKey, type ComponentEntry, type ProjectInfo } from '../../shared/protocol';

export function ComponentsPanel({ project, onPlace, onDesign, onScan, onAddProject, opening }: {
  project: ProjectInfo | null;
  onPlace: (component: ComponentEntry) => Promise<void>;
  onDesign: (component: ComponentEntry) => Promise<void>;
  onScan: () => Promise<void>;
  onAddProject: () => void;
  opening: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [details, setDetails] = useState<string>();

  async function act(action: string, fn: () => Promise<void>) {
    setBusy(action);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (!project) return <div className="empty"><button className="btn" onClick={onAddProject}>Open a project</button></div>;

  const query = filter.trim().toLowerCase();
  const grouped = new Map<string, ComponentEntry[]>();
  for (const component of project.components) {
    if (!`${component.name} ${component.group ?? ''} ${component.file}`.toLowerCase().includes(query)) continue;
    const group = component.group ?? '';
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(component);
  }
  const groups = [...grouped].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b));
  const scanning = project.catalog?.state === 'scanning';
  const unavailable = opening || !!busy;

  return (
    <div className="scroll components-panel">
      <div className="component-controls">
        <input className="input" aria-label="Search components" placeholder="Search components" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn small" disabled={unavailable || scanning} onClick={() => void act('scan', onScan)}>Rescan</button>
      </div>
      {scanning && <div className="hint" role="status">Claude is analyzing the project…</div>}
      {busy && busy !== 'scan' && <div className="hint" role="status">Preparing component preview…</div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {project.catalog?.state === 'failed' && <div className="hint" role="status">{project.catalog.detail} Source discovery is still available.</div>}
      {!!project.componentNotes?.length && <details className="hint"><summary>Catalog notes</summary>{project.componentNotes.map((note) => <p key={note}>{note}</p>)}</details>}
      {!groups.length && <div className="hint">{query ? 'No matching components.' : scanning ? 'Discovered components will appear here.' : 'No reusable components found.'}</div>}
      {groups.map(([group, components]) => (
        <section key={group} className="catalog-group" aria-label={group || 'Components'}>
          {(group || groups.length > 1) && <h3 className="comp-section">{group || 'Ungrouped'}</h3>}
          {components.map((component) => {
            const key = componentKey(component);
            const expanded = details === key;
            return (
              <div key={key} className="comp-entry">
                <div className="catalog-row">
                  <button className="catalog-component" disabled={unavailable} onClick={() => void act(key, () => onPlace(component))}>
                    <span className="catalog-diamond" aria-hidden="true">◇</span>
                    <span>{component.name}</span>
                  </button>
                  <button className="catalog-info" aria-expanded={expanded} aria-label={`Details for ${component.name}`} onClick={() => setDetails(expanded ? undefined : key)}>ⓘ</button>
                </div>
                {expanded && <div className="catalog-details">
                  <div className="mono">{component.file}</div>
                  {component.exportName && <div>Export <code>{component.exportName}</code></div>}
                  {component.props.length > 0 && <div>Props <code>{component.props.map((p) => p.name + (p.optional ? '?' : '')).join(', ')}</code></div>}
                  <button className="btn small" disabled={unavailable} onClick={() => void act('design', () => onDesign(component))}>Add empty linked frame</button>
                </div>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
