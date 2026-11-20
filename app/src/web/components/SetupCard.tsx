import { useEffect, useState } from 'react';
import type { SetupActivity, SetupState } from '../../shared/protocol';

const MARK: Record<string, string> = { done: '✓', failed: '!', running: '•', skipped: '–', pending: '○', error: '!' };
const KIND: Record<SetupActivity['kind'], string> = { run: '$', read: '◫', search: '⌕', edit: '✎', preview: '▶', web: '↗', other: '·' };

const host = (url?: string) => url?.replace(/^https?:\/\//, '');

/**
 * The setup tasks view: while Claude works out how the opened repo runs, it shows Claude's plan as
 * tasks, what it is doing right now, and (on demand) every command it ran. Once the project runs it
 * folds into a one-line summary of what Claude found; on failure it says why and offers a fix.
 */
export function SetupCard({ setup, reveal, onRetry, onAsk }: { setup: SetupState | null; reveal: number; onRetry: (fresh: boolean) => void; onAsk: (prompt: string) => void }) {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState(false);
  useEffect(() => {
    setHidden(false);
    setOpen(true);
    setLog(false);
  }, [setup?.project, setup?.startedAt]);
  useEffect(() => {
    if (!reveal) return;
    setHidden(false);
    setOpen(true);
  }, [reveal]);
  // Once it runs, fold down to the one-line summary so the canvas is free.
  useEffect(() => {
    if (setup?.status !== 'done') return;
    const t = setTimeout(() => setOpen(false), 5000);
    return () => clearTimeout(t);
  }, [setup?.status]);
  if (!setup || hidden) return null;

  const p = setup.profile;
  const now = [...setup.activity].reverse().find((a) => a.status === 'running');
  const title =
    setup.status === 'running'
      ? setup.by === 'saved'
        ? 'Starting your project'
        : 'Claude is getting your project running'
      : setup.status === 'failed'
        ? 'Setup needs a hand'
        : 'Project is running';
  const failed = setup.tasks.find((t) => t.status === 'failed');
  const seconds = Math.round(((setup.finishedAt ?? Date.now()) - setup.startedAt) / 1000);

  return (
    <div className={`setup-card ${setup.status}`} role="status" aria-live="polite" data-canvas-keys="off">
      <div className="setup-head">
        {setup.status === 'running' ? <span className="setup-spin" aria-hidden="true" /> : <span className={`setup-dot ${setup.status}`} aria-hidden="true" />}
        <button className="setup-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          {title}
          {p?.stack && <span className="faint"> · {p.stack}</span>}
        </button>
        <button className="toast-close" aria-label="Hide" onClick={() => setHidden(true)}>×</button>
      </div>

      {open && (
        <>
          {setup.status === 'running' && setup.message && <div className="setup-message">{setup.message}</div>}
          {setup.status === 'done' && p?.summary && <div className="setup-message">{p.summary}</div>}

          {setup.tasks.length > 0 && (
            <ol className="setup-steps">
              {setup.tasks.map((t) => (
                <li key={t.id} className={t.status}>
                  <span className="mark" aria-hidden="true">{MARK[t.status]}</span>
                  <span className="label">{t.label}</span>
                  {t.status === 'running' && now ? (
                    <span className="detail mono" title={now.text}>{now.text}</span>
                  ) : (
                    t.detail && <span className="detail mono" title={t.detail}>{t.detail}</span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {setup.status === 'done' && (
            <div className="setup-where">
              {setup.appUrl && <span>App <span className="mono">{host(setup.appUrl)}</span></span>}
              {setup.storybookUrl && <span>Storybook <span className="mono">{host(setup.storybookUrl)}</span></span>}
              {p && <span className="faint">{p.components === 'storybook' ? 'Components place from stories' : 'Edits show in the app frame'}</span>}
            </div>
          )}
          {setup.status === 'done' && p?.notes.length ? (
            <ul className="setup-notes">
              {p.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}

          {setup.activity.length > 0 && (
            <>
              <button className="setup-log-toggle" onClick={() => setLog(!log)} aria-expanded={log}>
                {log ? 'Hide' : 'Show'} what Claude did ({setup.activity.length}){setup.status !== 'running' ? ` · ${seconds}s` : ''}
              </button>
              {log && (
                <ol className="setup-log">
                  {setup.activity.map((a) => (
                    <li key={a.id} className={a.status}>
                      <span className="mark mono" aria-hidden="true">{a.status === 'running' ? '•' : a.status === 'error' ? '!' : KIND[a.kind]}</span>
                      <span className="mono" title={a.text}>{a.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}

          {setup.status === 'failed' && (
            <>
              {setup.error && <pre className="setup-error">{setup.error}</pre>}
              <div className="setup-actions">
                <button className="btn small" onClick={() => onRetry(true)}>Try again</button>
                <button
                  className="btn small primary"
                  onClick={() =>
                    onAsk(
                      `Designer's setup could not get this project running${failed ? ` (the step "${failed.label}" failed)` : ''}. It said:\n\n${setup.error ?? ''}\n\nFind out why and fix it, following the repo's own tooling, then start it with run_project so it shows on the canvas. Ask me if it needs something only I can give (like a secret).`,
                    )
                  }
                >
                  Ask Claude to fix it
                </button>
              </div>
            </>
          )}
          {setup.status === 'done' && (
            <div className="setup-actions">
              <button className="btn small" onClick={() => onRetry(true)} title="Ask Claude to work out how it runs again">Set up again</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
