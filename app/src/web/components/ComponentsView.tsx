import { useState } from 'react';
import type { StoryEntry } from '../../shared/protocol';

/** Every component from the repo's Storybook stories, rendered story by story (Storybook's own UI is never shown). */
export function ComponentsView({
  stories,
  storybookUrl,
  hasScript,
  starting,
  onStart,
  onAsk,
  reloadKey,
}: {
  stories: StoryEntry[];
  storybookUrl?: string;
  hasScript: boolean;
  starting: boolean;
  onStart: () => void;
  onAsk: (text: string) => void;
  reloadKey: number;
}) {
  const [current, setCurrent] = useState(0);
  const [args, setArgs] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  if (!stories.length)
    return (
      <div className="welcome">
        <div className="card">
          <h2>No component stories yet</h2>
          <p>Designer builds this view from your repo's Storybook stories (*.stories.tsx). Claude can write them for your existing components.</p>
          <div className="actions">
            <button className="btn primary" onClick={() => onAsk('Find the main reusable UI components in this repo and write a Storybook story file (CSF3) for each one, with one story per meaningful variant. Follow the conventions already in the repo.')}>
              Ask Claude to write stories
            </button>
          </div>
        </div>
      </div>
    );
  const entry = stories[Math.min(current, stories.length - 1)];
  return (
    <div className="components">
      <div className="story-list">
        <div className="section-title">Components ({stories.length})</div>
        {stories.map((s, i) => (
          <button key={s.file} className={i === current ? 'on' : ''} onClick={() => setCurrent(i)}>
            {s.title}
            <div className="faint">{s.stories.length} variants</div>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, padding: '10px 20px 0', alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>{entry.title}</b>
          <span className="faint mono">{entry.file}</span>
          <span style={{ flex: 1 }} />
          <div className="segmented">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
          </div>
          <input className="input" placeholder="Preview props, e.g. label:Save;disabled:!true" value={args} onChange={(e) => setArgs(e.target.value)} style={{ width: 260 }} />
          <button className="btn small" onClick={() => onAsk(`Context: component ${entry.title} (${entry.file}).`)}>Ask Claude about it</button>
        </div>
        {!storybookUrl ? (
          <div className="welcome">
            <div className="card">
              <h2>Render the variants</h2>
              <p>Designer starts your Storybook in the background and shows each story as a live preview.</p>
              {hasScript ? (
                <button className="btn primary" onClick={onStart} disabled={starting}>{starting ? 'Starting…' : 'Render components (npm run storybook)'}</button>
              ) : (
                <p>This project has no "storybook" script.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="matrix">
            {entry.stories.map((s) => (
              <div key={s.id} className="variant">
                <div className="head">
                  <b>{s.name}</b>
                  <span className="faint mono">{s.exportName}</span>
                </div>
                <iframe
                  key={reloadKey}
                  title={s.id}
                  src={`${storybookUrl}/iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story&globals=${encodeURIComponent(`theme:${theme};backgrounds.value:${theme === 'dark' ? '!hex(1e1e1e)' : '!hex(ffffff)'}`)}${args ? `&args=${encodeURIComponent(args)}` : ''}`}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
