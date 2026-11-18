import { useState } from 'react';
import type { ComponentEntry, ProjectInfo } from '../../shared/protocol';

const storyPrompt = (c: ComponentEntry) =>
  `Write a Storybook story file (CSF3) for the ${c.name} component in ${c.file}${c.exportName === 'default' ? ' (default export)' : ''}, with one story per meaningful variant of its props${c.props.length ? ` (${c.props.map((p) => p.name).join(', ')})` : ''}. Set Storybook up first if the repo does not have it, following the repo's tooling. Then show it on the canvas.`;

/** Components found in the source that have no story yet: the canvas renders a component from its story. */
function Unstoried({ list, onAsk }: { list: ComponentEntry[]; onAsk: (p: string) => void }) {
  if (!list.length) return null;
  return (
    <>
      <div className="comp-section">Without a story yet · {list.length}</div>
      {list.map((c) => (
        <div key={`${c.file}#${c.exportName}`} className="comp-entry">
          <div className="comp-story" style={{ paddingLeft: 12 }} title={c.file}>
            <span>
              <span className="code-glyph">{'</>'}</span> <span className="comp-name">{c.name}</span> <span className="faint" style={{ opacity: 1 }}>{c.file.split('/').slice(-2, -1)[0] ?? ''}</span>
            </span>
            <button className="btn small ghost" onClick={() => onAsk(storyPrompt(c))}>Make story</button>
          </div>
          {c.props.length > 0 && <div className="comp-props mono">{c.props.slice(0, 8).map((p) => `${p.name}${p.optional ? '?' : ''}`).join(', ')}{c.props.length > 8 ? ', …' : ''}</div>}
        </div>
      ))}
    </>
  );
}

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
  const components = project.components ?? [];
  const unstoried = components.filter((c) => !c.storyIds.length && (!filter || c.name.toLowerCase().includes(filter.toLowerCase())));
  if (!project.stories.length)
    return (
      <div className={components.length ? 'scroll components-panel' : 'empty'}>
        {components.length ? (
          <div className="hint" style={{ paddingTop: 10 }}>
            Found {components.length} component{components.length === 1 ? '' : 's'} in this repo. The canvas renders a component from its story, so give it one to place it.
          </div>
        ) : (
          'No component stories in this repo yet. Designer renders each component on the canvas from its story.'
        )}
        {components.length > 0 && <Unstoried list={unstoried} onAsk={onAsk} />}
        <div style={{ margin: components.length ? '10px 12px' : '10px 0 0' }}>
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
      <Unstoried list={unstoried} onAsk={onAsk} />
    </div>
  );
}
