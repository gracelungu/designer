import { useEffect, useState } from 'react';
import type { ClaudeInstall } from '../../shared/protocol';
import { api } from '../api';

export type StartChoice = 'demo' | 'project' | 'blank';
type Step = 'welcome' | 'claude' | 'figma' | 'start';
const STEPS: Step[] = ['welcome', 'claude', 'figma', 'start'];

interface FigmaCheck {
  state: 'connected' | 'not-running' | 'error';
  detail?: string;
}

/**
 * First-run welcome: what Designer is, a Claude Code check, optional Figma,
 * then how to start (the bundled demo, your own project, or a blank canvas).
 */
export function Onboarding({ claude: initialClaude, demo, onDone }: { claude: ClaudeInstall; demo: boolean; onDone: (choice: StartChoice, claude: ClaudeInstall) => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [claude, setClaude] = useState(initialClaude);
  const [checking, setChecking] = useState(false);
  const [figma, setFigma] = useState<FigmaCheck>();
  const [choice, setChoice] = useState<StartChoice>(demo ? 'demo' : 'project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = claude.found && claude.loggedIn;
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]);

  const recheckClaude = async () => {
    setChecking(true);
    try {
      setClaude(await api<ClaudeInstall>('/api/claude/recheck', {}));
    } finally {
      setChecking(false);
    }
  };
  const checkFigma = async () => {
    setFigma(undefined);
    setFigma(await api<FigmaCheck>('/api/figma/status').catch((e: Error) => ({ state: 'error' as const, detail: e.message })));
  };
  useEffect(() => {
    if (step === 'figma' && !figma) void checkFigma();
  }, [step, figma]);

  const finish = async (c: StartChoice) => {
    setBusy(true);
    setError('');
    try {
      await api('/api/onboarding', { startedWith: c });
      onDone(c, claude);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="welcome onboarding" data-testid="onboarding">
      <div className="card onboard-card">
        <div className="onboard-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span key={s} className={i <= index ? 'on' : ''} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <h2>Welcome to Designer</h2>
            <p>Design on a canvas that feels like Figma, in your real code. Claude Code, already on your computer, does the coding.</p>
            <ul className="onboard-list">
              <li><b>Live components.</b> Put your repo’s components on the canvas, rendered from code, next to your designs.</li>
              <li><b>Ask in plain words.</b> “Make the cards denser” changes the code, and you see it straight away.</li>
              <li><b>No git to learn.</b> Get latest, Save version and Share for review do it for you.</li>
            </ul>
            <div className="actions">
              <button className="btn primary" onClick={next}>Get started</button>
            </div>
          </>
        )}

        {step === 'claude' && (
          <>
            <h2>Connect Claude Code</h2>
            <p>Designer uses the Claude Code installed on this Mac, with your own sign-in, settings, skills and MCP servers. Nothing is sent anywhere else.</p>
            <div className={`onboard-check ${ready ? 'ok' : 'warn'}`} data-testid="claude-check">
              {ready ? (
                <span>✓ Found Claude Code {claude.version} and you’re signed in.</span>
              ) : !claude.found ? (
                <span>
                  Claude Code isn’t installed yet. Install it in Terminal, then check again:
                  <br />
                  <code>curl -fsSL https://claude.ai/install.sh | bash</code>
                </span>
              ) : (
                <span>
                  Found <code>{claude.path}</code>, but it isn’t signed in. Run <code>claude</code> in Terminal and sign in, then check again.
                </span>
              )}
            </div>
            <div className="actions">
              <button className="btn" onClick={back}>Back</button>
              <span className="grow" />
              {!ready && (
                <button className="btn" onClick={recheckClaude} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
              )}
              <button className="btn primary" onClick={next}>{ready ? 'Continue' : 'Skip for now'}</button>
            </div>
          </>
        )}

        {step === 'figma' && (
          <>
            <h2>Bring in Figma (optional)</h2>
            <p>With the Figma desktop app open, Designer reads what you select there. No token or sign-in is needed.</p>
            <div className={`onboard-check ${figma?.state === 'connected' ? 'ok' : 'warn'}`} data-testid="figma-check">
              {!figma ? (
                <span>Looking for Figma…</span>
              ) : figma.state === 'connected' ? (
                <span>✓ Figma is connected.</span>
              ) : (
                <span>
                  Figma isn’t connected. In the Figma desktop app, open the menu, then <b>Preferences › Enable Dev Mode MCP Server</b>. You can do this later from <b>Import from Figma</b>.
                </span>
              )}
            </div>
            <div className="actions">
              <button className="btn" onClick={back}>Back</button>
              <span className="grow" />
              {figma && figma.state !== 'connected' && <button className="btn" onClick={checkFigma}>Check again</button>}
              <button className="btn primary" onClick={next}>{figma?.state === 'connected' ? 'Continue' : 'Skip'}</button>
            </div>
          </>
        )}

        {step === 'start' && (
          <>
            <h2>How would you like to start?</h2>
            <div className="onboard-choices" role="radiogroup">
              {demo && (
                <label className={choice === 'demo' ? 'on' : ''}>
                  <input type="radio" name="start" checked={choice === 'demo'} onChange={() => setChoice('demo')} />
                  <span>
                    <b>Try the demo project</b>
                    <small>A small pricing page with tokens, components and stories. A copy goes in your Designer folder, so play freely.</small>
                  </span>
                </label>
              )}
              <label className={choice === 'project' ? 'on' : ''}>
                <input type="radio" name="start" checked={choice === 'project'} onChange={() => setChoice('project')} />
                <span>
                  <b>Open my own project</b>
                  <small>Pick your repository’s folder.</small>
                </span>
              </label>
              <label className={choice === 'blank' ? 'on' : ''}>
                <input type="radio" name="start" checked={choice === 'blank'} onChange={() => setChoice('blank')} />
                <span>
                  <b>Start with a blank canvas</b>
                  <small>Sketch first, or tell Claude which project to open.</small>
                </span>
              </label>
            </div>
            {error && <p className="error-box">{error}</p>}
            <div className="actions">
              <button className="btn" onClick={back}>Back</button>
              <span className="grow" />
              <button className="btn primary" disabled={busy} onClick={() => void finish(choice)}>{busy ? 'Opening…' : 'Open Designer'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
