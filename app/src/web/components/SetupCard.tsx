import { useEffect, useState } from 'react';
import type { SetupState } from '../../shared/protocol';

/**
 * Shows what Designer is doing to get a newly added project running: detect, index, install,
 * start, Storybook. It folds itself away a few seconds after everything worked.
 */
export function SetupCard({ setup, onRetry, onAsk }: { setup: SetupState | null; onRetry: () => void; onAsk: (prompt: string) => void }) {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setHidden(false);
    setOpen(true);
  }, [setup?.project]);
  useEffect(() => {
    if (setup?.status !== 'done') return;
    const t = setTimeout(() => setHidden(true), 6000);
    return () => clearTimeout(t);
  }, [setup?.status]);
  if (!setup || hidden) return null;
  const failed = setup.steps.find((s) => s.status === 'failed');
  const title = setup.status === 'running' ? 'Setting up your project' : setup.status === 'failed' ? 'Setup needs a hand' : 'Project is ready';
  return (
    <div className={`setup-card ${setup.status}`} role="status" aria-live="polite" data-canvas-keys="off">
      <div className="setup-head">
        {setup.status === 'running' ? <span className="setup-spin" aria-hidden="true" /> : <span className={`setup-dot ${setup.status}`} aria-hidden="true" />}
        <button className="setup-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          {title}
          {setup.plan && <span className="faint"> · {setup.plan.frameworkName}</span>}
        </button>
        <button className="toast-close" aria-label="Hide" onClick={() => setHidden(true)}>×</button>
      </div>
      {open && (
        <ol className="setup-steps">
          {setup.steps.map((s) => (
            <li key={s.id} className={s.status}>
              <span className="mark" aria-hidden="true">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'running' ? '•' : s.status === 'skipped' ? '–' : '○'}</span>
              <span className="label">{s.label}</span>
              {s.detail && <span className="detail mono" title={s.detail}>{s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {setup.status === 'failed' && (
        <>
          {setup.error && <pre className="setup-error">{setup.error}</pre>}
          <div className="setup-actions">
            <button className="btn small" onClick={onRetry}>Try again</button>
            <button
              className="btn small primary"
              onClick={() =>
                onAsk(
                  `Designer could not set this project up automatically. The step "${failed?.label ?? 'setup'}" failed with:\n\n${setup.error ?? ''}\n\nFind out why, fix it (follow the repo's own tooling), and start the project with run_project so it shows on the canvas.`,
                )
              }
            >
              Ask Claude to fix it
            </button>
          </div>
        </>
      )}
    </div>
  );
}
