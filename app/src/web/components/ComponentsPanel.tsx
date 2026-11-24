import { useState } from 'react';
import { componentKey, type ComponentCatalogStatus, type ComponentEntry, type ComponentScanStep, type ProjectInfo } from '../../shared/protocol';

export function ComponentsPanel({ project, onPlace, onDesign, onScan, onAddProject, onAgentSetup, opening }: {
  project: ProjectInfo | null;
  onPlace: (component: ComponentEntry) => Promise<void>;
  onDesign: (component: ComponentEntry) => Promise<void>;
  onScan: () => Promise<void>;
  onAddProject: () => void;
  onAgentSetup: () => void;
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
      {project.catalog && <ProjectScan status={project.catalog} count={project.components.length} onAgentSetup={onAgentSetup} />}
      {busy && busy !== 'scan' && <div className="hint" role="status">Preparing component preview…</div>}
      {error && <div className="error-box" role="alert">{error}</div>}
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


const SCAN_STEPS: { id: ComponentScanStep; title: string; detail: string }[] = [
  { id: 'connect', title: 'Start Claude Code', detail: 'Opening a session for this folder' },
  { id: 'inspect', title: 'Inspect the project', detail: 'Finding UI source, dependencies, and component usage' },
  { id: 'catalog', title: 'Prepare component previews', detail: 'Determining how components mount and which inputs they need' },
  { id: 'validate', title: 'Check the catalog', detail: 'Checking source paths and adding components to the list' },
];

function ProjectScan({ status, count, onAgentSetup }: { status: ComponentCatalogStatus; count: number; onAgentSetup: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const current = SCAN_STEPS.findIndex((step) => step.id === status.step);
  const complete = status.state === 'ready';
  if (status.state === 'local') return status.detail && (
    <div className="project-scan">
      <p>{status.detail}</p>
      <button className="btn small" onClick={onAgentSetup}>Open Claude setup</button>
    </div>
  );
  return (
    <div className="project-scan" aria-label="Project analysis">
      {complete ? (
        <button className="scan-summary" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
          <span aria-hidden="true">✓</span> {count} {count === 1 ? 'component' : 'components'} · Scan complete
        </button>
      ) : <strong>{status.state === 'failed' ? 'Project scan stopped' : 'Analyzing project'}</strong>}
      {(!complete || historyOpen) && (
        <ol className="scan-steps">
          {SCAN_STEPS.map((step, index) => {
            const active = !complete && index === current;
            const done = complete || index < current;
            return (
              <li key={step.id} aria-current={active ? 'step' : undefined} className={active || done ? '' : 'faint'}>
                <span className="scan-step-mark" aria-hidden="true">{done ? '✓' : active ? (status.state === 'failed' ? '!' : '●') : '○'}</span>
                <div>
                  <span>{step.title}</span>
                  {active && <div className="scan-activity" role="status">{status.detail ?? status.activity ?? step.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
