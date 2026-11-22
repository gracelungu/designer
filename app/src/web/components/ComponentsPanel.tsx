import { useState } from 'react';
import type { ComponentEntry, ProjectInfo } from '../../shared/protocol';

export function ComponentsPanel({
  project, onPlace, onDesign, onRun, onAttach, onRefresh, onAddSource, onAddProject, running, opening,
}: {
  project: ProjectInfo | null;
  onPlace: (storyId: string) => Promise<void>;
  onDesign: (component: ComponentEntry) => Promise<void>;
  onRun: () => Promise<void>;
  onAttach: (url: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onAddSource: (source: { name: string; file: string; exportName: string }) => Promise<void>;
  onAddProject: () => void;
  running: boolean;
  opening: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const act = async (action: string, fn: () => Promise<void>) => {
    setBusy(action);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (!project) return <div className="empty"><button className="btn" onClick={onAddProject}>Open a project</button></div>;

  const blocked = opening || !!busy;
  const components = project.components ?? [];
  const stories = project.stories.flatMap((entry) => entry.stories.map((story) => ({ ...story, title: entry.title, file: entry.file })));
  const byId = new Map(stories.map((story) => [story.id, story]));
  const linked = new Set(components.flatMap((component) => component.storyIds));
  const query = filter.trim().toLowerCase();
  const matches = (...text: string[]) => text.some((value) => value.toLowerCase().includes(query));
  const rows = components.filter((c) => matches(c.name, c.file, c.exportName, ...c.storyIds.map((id) => byId.get(id)?.name ?? '')));
  const examples = stories.filter((s) => !linked.has(s.id) && matches(s.title, s.name, s.file));
  const place = (id: string, label: string) => (
    <button key={id} className="comp-story" disabled={blocked} onClick={() => void act(id, () => onPlace(id))}>
      <span>{label}</span>
      <span className="faint">{busy === id ? 'Opening…' : 'Preview'}</span>
    </button>
  );

  return (
    <div className="scroll components-panel">
      <div className="component-controls">
        <input className="input" aria-label="Search components" placeholder="Search components" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn small" disabled={blocked} onClick={() => void act('refresh', onRefresh)}>Refresh</button>
      </div>
      <div className="component-controls">
        <button className="btn small" disabled={running || blocked} onClick={() => void act('run', onRun)}>{running ? 'Starting…' : 'Run preview'}</button>
        <button className="btn small ghost" onClick={() => setPreviewOpen(!previewOpen)} aria-expanded={previewOpen}>Use a local URL</button>
        <button className="btn small ghost" onClick={() => setSourceOpen(!sourceOpen)} aria-expanded={sourceOpen}>Add source</button>
      </div>
      {previewOpen && (
        <form className="component-controls" onSubmit={(e) => {
          e.preventDefault();
          void act('attach', async () => { await onAttach(url.trim()); setPreviewOpen(false); });
        }}>
          <input className="input" type="url" aria-label="Local preview URL" placeholder="http://localhost:3000" required value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" disabled={blocked}>Open</button>
        </form>
      )}
      {sourceOpen && (
        <form className="component-source-form" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void act('add', async () => {
            await onAddSource({ name: String(fields.get('name')), file: String(fields.get('file')), exportName: String(fields.get('exportName')) });
            setFilter('');
            setSourceOpen(false);
          });
        }}>
          <label>Component name<input className="input" name="name" required /></label>
          <label>File path in the project<input className="input" name="file" placeholder="templates/badge.html" required /></label>
          <label>Export name (optional)<input className="input" name="exportName" /></label>
          <button className="btn small primary" disabled={blocked}>Add component</button>
        </form>
      )}
      {error && <div className="error-box" role="alert">{error}</div>}
      {project.componentNotes?.map((note) => <div key={note} className="hint">{note}</div>)}
      {!rows.length && !examples.length && (
        <div className="hint">{query ? 'No matching components.' : 'No components found. Add a source file or open a running preview.'}</div>
      )}
      {rows.map((c) => (
        <div key={`${c.file}#${c.exportName}`} className="comp-entry">
          <div className="comp-head" title={c.file}>
            <span className="code-glyph">{'</>'}</span>
            <span className="comp-name">{c.name}</span>
          </div>
          <div className="comp-props mono" title={c.file}>{c.file}</div>
          {c.props.length > 0 && <div className="comp-props mono">{c.props.slice(0, 8).map((p) => `${p.name}${p.optional ? '?' : ''}`).join(', ')}{c.props.length > 8 ? ', …' : ''}</div>}
          {c.storyIds.map((id) => byId.get(id)).map((s) => s && place(s.id, s.name))}
          <button className="comp-story" disabled={blocked} onClick={() => void act(`${c.file}#${c.exportName}`, () => onDesign(c))}>
            <span>Add editable frame</span>
            <span className="faint">Linked to source</span>
          </button>
        </div>
      ))}
      {examples.length > 0 && <div className="comp-section">More previews</div>}
      {examples.map((s) => place(s.id, `${s.title.split('/').pop()} / ${s.name}`))}
    </div>
  );
}
