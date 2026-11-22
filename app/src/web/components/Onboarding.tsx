import { useState } from 'react';
import { api } from '../api';

export type StartChoice = 'demo' | 'project' | 'blank';

export function Onboarding({ demo, onDone }: { demo: boolean; onDone: (choice: StartChoice) => void }) {
  const [busy, setBusy] = useState<StartChoice>();
  const [error, setError] = useState('');

  const finish = async (choice: StartChoice) => {
    setBusy(choice);
    setError('');
    try {
      await api('/api/onboarding', { startedWith: choice });
      onDone(choice);
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  };

  return (
    <div className="welcome onboarding" data-testid="onboarding">
      <div className="card onboard-card">
        <h2>Welcome to Designer</h2>
        <p>Open a project to find its components, or start with a blank canvas.</p>
        <div className="onboard-choices">
          <button className="btn primary" disabled={!!busy} onClick={() => void finish('project')}>Open a project</button>
          <button className="btn" disabled={!!busy} onClick={() => void finish('blank')}>Start with a blank canvas</button>
          {demo && <button className="btn" disabled={!!busy} onClick={() => void finish('demo')}>Try the demo</button>}
        </div>
        {error && <p className="error-box" role="alert">{error}</p>}
      </div>
    </div>
  );
}
