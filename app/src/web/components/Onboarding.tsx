import { useState } from 'react';
import type { ProjectInfo } from '../../shared/protocol';
import { api } from '../api';
import { ProjectPicker } from './ProjectPicker';

export type StartChoice = 'demo' | 'project' | 'blank';

export function Onboarding({ demo, home, onDone }: { demo: boolean; home: string; onDone: (choice: StartChoice, project?: string) => void }) {
  const [busy, setBusy] = useState<StartChoice>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  async function finish(choice: StartChoice, path?: string) {
    await api('/api/onboarding', { startedWith: choice });
    onDone(choice, path);
  }

  async function open(path: string) {
    const project = await api<ProjectInfo>('/api/project', { path, setup: false });
    await finish('project', project.path);
  }

  async function choose(choice: StartChoice) {
    setError('');
    if (choice === 'project' && !window.designerNative) {
      setPicking(true);
      return;
    }
    setBusy(choice);
    try {
      if (choice === 'project') {
        const path = await window.designerNative!.pickFolder();
        if (path) await open(path);
      } else {
        await finish(choice);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="welcome onboarding" data-testid="onboarding">
      {picking ? <ProjectPicker home={home} onOpen={open} onCancel={() => setPicking(false)} /> : (
        <div className="card onboard-card">
          <h2>Welcome to Designer</h2>
          <p>Choose a project folder to discover its components and open them on the canvas.</p>
          <div className="onboard-choices">
            <button className="btn primary" disabled={!!busy} onClick={() => void choose('project')}>{busy === 'project' ? 'Opening project…' : 'Open a project'}</button>
            <button className="btn" disabled={!!busy} onClick={() => void choose('blank')}>Start with a blank canvas</button>
            {demo && <button className="btn" disabled={!!busy} onClick={() => void choose('demo')}>Try the demo</button>}
          </div>
          {error && <p className="error-box" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
