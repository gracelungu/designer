import { useEffect, useState } from 'react';
import type { ShareStep, VisualReview, VisualShot } from '../../shared/protocol';
import { api, reviewImage, socket } from '../api';

export function pct(r?: number) {
  if (r === undefined) return '';
  const p = r * 100;
  return `${p < 0.1 && p > 0 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export function reviewSummary(r: VisualReview) {
  if (r.capturing) return 'Taking after pictures…';
  const shot = r.shots.filter((s) => s.after).length;
  const changed = r.shots.filter((s) => (s.changed ?? 0) > 0).length;
  if (!r.shots.length) return r.note ? 'Nothing to photograph' : 'No views';
  if (!shot) return 'Screenshots could not be taken';
  return changed ? `${changed} of ${shot} view${shot === 1 ? '' : 's'} changed` : 'No visible change';
}

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** The "Visual changes" list at the top of Code › Changes: one card per change, newest first. */
export function VisualChanges({ reviews, onOpen }: { reviews: VisualReview[]; onOpen: (r: VisualReview) => void }) {
  return (
    <>
      <div className="section-title">Visual changes</div>
      {reviews.length === 0 && <div className="empty">When Claude changes a component on the canvas, a before and after picture shows up here.</div>}
      {reviews.slice(0, 20).map((r) => {
        const lead = r.shots.find((s) => s.diff) ?? r.shots.find((s) => s.after);
        return (
          <button key={r.id} className="review-card" onClick={() => onOpen(r)} data-testid="review-card">
            <div className="review-thumb">{lead?.after ? <img src={reviewImage(r.id, lead.after)} alt="" /> : <span className="faint">{r.capturing ? '…' : '—'}</span>}</div>
            <div className="review-meta">
              <b>{r.title}</b>
              <span className="muted">{reviewSummary(r)}</span>
              <span className="faint">
                {ago(r.createdAt)} · {r.files.length} file{r.files.length === 1 ? '' : 's'}
                {r.sentIn && ' · sent'}
              </span>
            </div>
          </button>
        );
      })}
    </>
  );
}

type Mode = 'side' | 'slider' | 'highlight';

/** Full-size before / after for one change: side by side, a slider to wipe between them, or the changed pixels in red. */
export function ReviewViewer({ review, onClose, onAsk }: { review: VisualReview; onClose: () => void; onAsk?: (prompt: string) => void }) {
  const [r, setR] = useState(review);
  const [i, setI] = useState(() => Math.max(0, review.shots.findIndex((s) => s.diff)));
  const [mode, setMode] = useState<Mode>('side');
  const [split, setSplit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [bust, setBust] = useState('');
  useEffect(() => setR(review), [review]);
  const shot: VisualShot | undefined = r.shots[i];
  const img = (f?: string) => (f ? reviewImage(r.id, f, bust) : undefined);
  const retake = async () => {
    setBusy(true);
    try {
      setR(await api<VisualReview>('/api/visual-reviews/retake', { id: r.id }));
      setBust(String(Date.now()));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal review-modal" onClick={(e) => e.stopPropagation()} data-canvas-keys="off" role="dialog" aria-label="Visual review">
        <div className="review-head">
          <div>
            <h3>{r.title}</h3>
            <p>
              {reviewSummary(r)} · {r.files.join(', ')}
            </p>
          </div>
          <button className="toast-close dark" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {r.note && <p className="muted">{r.note}</p>}
        {r.shots.length > 1 && (
          <div className="review-tabs">
            {r.shots.map((s, k) => (
              <button key={s.key} className={k === i ? 'on' : ''} onClick={() => setI(k)}>
                {s.label} {s.changed ? <span className="badge dark">{pct(s.changed)}</span> : <span className="faint">{s.error ? '!' : '='}</span>}
              </button>
            ))}
          </div>
        )}
        {shot && (
          <>
            <div className="review-bar">
              <div className="segmented small">
                <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>Side by side</button>
                <button className={mode === 'slider' ? 'on' : ''} onClick={() => setMode('slider')} disabled={!shot.before || !shot.after}>Slider</button>
                <button className={mode === 'highlight' ? 'on' : ''} onClick={() => setMode('highlight')} disabled={!shot.diff}>Highlight</button>
              </div>
              <span className="muted">{shot.changed !== undefined ? `${pct(shot.changed)} of pixels changed${shot.sizeChanged ? ', size changed' : ''}` : ''}</span>
            </div>
            {shot.error && <div className="error-box">{shot.error}</div>}
            {mode === 'side' && (
              <div className="review-side">
                <figure>
                  <figcaption>Before</figcaption>
                  {shot.before ? <img src={img(shot.before)} alt={`${shot.label} before`} /> : <div className="empty">No picture</div>}
                </figure>
                <figure>
                  <figcaption>After</figcaption>
                  {shot.after ? <img src={img(shot.after)} alt={`${shot.label} after`} /> : <div className="empty">No picture</div>}
                </figure>
              </div>
            )}
            {mode === 'slider' && shot.before && shot.after && (
              <div className="review-slider">
                <div className="review-stack">
                  <img src={img(shot.after)} alt={`${shot.label} after`} />
                  <img src={img(shot.before)} alt={`${shot.label} before`} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
                  <div className="review-split" style={{ left: `${split}%` }} />
                </div>
                <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Before / after" />
              </div>
            )}
            {mode === 'highlight' && shot.diff && (
              <div className="review-side one">
                <figure>
                  <figcaption>Changed pixels in red</figcaption>
                  <img src={img(shot.diff)} alt={`${shot.label} changes highlighted`} />
                </figure>
              </div>
            )}
          </>
        )}
        <div className="actions">
          {onAsk && shot && (
            <button className="btn" onClick={() => (onAsk(`About the change "${r.title}" to ${shot.label}: `), onClose())}>Ask Claude about this</button>
          )}
          <button className="btn" onClick={() => void api('/api/visual-reviews/remove', { id: r.id }).then(onClose)}>Dismiss</button>
          <button className="btn" onClick={retake} disabled={busy}>{busy ? 'Taking pictures…' : 'Retake after'}</button>
        </div>
      </div>
    </div>
  );
}

const STEPS: { step: ShareStep; label: string }[] = [
  { step: 'branch', label: 'Put it on a branch of its own' },
  { step: 'save', label: 'Save your changes as a version' },
  { step: 'screenshots', label: 'Upload before and after pictures' },
  { step: 'push', label: 'Send it to the team’s copy' },
  { step: 'pr', label: 'Open the review' },
];

type StepState = { state: 'running' | 'done' | 'skipped' | 'error'; detail?: string };

/** One click from the canvas to a pull request with screenshots: no git words, no terminal. */
export function SendForReview({
  reviews,
  unsaved,
  onClose,
  onDone,
  onPreview,
}: {
  reviews: VisualReview[];
  unsaved: number;
  onClose: () => void;
  onDone: (r: { ok: boolean; message: string; url?: string }) => void;
  /** Writes the design preview (frames, comments, specs) into the project before sending. */
  onPreview?: () => Promise<unknown>;
}) {
  const pending = reviews.filter((r) => !r.sentIn && r.shots.length);
  const [title, setTitle] = useState(() => pending[0]?.title ?? '');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pending.map((r) => r.id)));
  const [steps, setSteps] = useState<Partial<Record<ShareStep, StepState>>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string; url?: string; needsConfirm?: boolean }>();
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    const off = socket.on((m) => {
      if (m.type === 'share-step') setSteps((s) => ({ ...s, [m.step]: { state: m.state, detail: m.detail } }));
    });
    return () => void off();
  }, []);

  const send = async () => {
    setSending(true);
    setSteps({});
    try {
      if (preview && onPreview) await onPreview();
      const r = await api<{ ok: boolean; message: string; url?: string; needsConfirm?: boolean }>('/api/git/send', { title, description, reviewIds: [...picked], preview });
      setResult(r);
      onDone(r);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSending(false);
    }
  };
  const open = (url: string) => (window.designerNative ? window.designerNative.openExternal(url) : window.open(url, '_blank', 'noreferrer'));

  return (
    <div className="modal-back" onClick={() => !sending && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-canvas-keys="off" role="dialog" aria-label="Share for review">
        <h3>Share for review</h3>
        {!sending && !result && (
          <>
            <p>Sends your changes to the team as a review (a pull request) with before and after pictures. Your work goes on a branch of its own, so the main design is not touched until someone approves it.</p>
            <label className="field">
              <span>Title</span>
              <input className="input" autoFocus placeholder="e.g. Denser pricing cards" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>What should reviewers look at? (optional)</span>
              <textarea className="input area" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            {onPreview && (
              <label className="modal-option">
                <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
                <span>Include a design preview for developers (frames, comments and specs, linked from the pull request)</span>
              </label>
            )}
            {pending.length > 0 ? (
              <div className="field">
                <span>Pictures to include</span>
                {pending.map((r) => {
                  const lead = r.shots.find((s) => s.diff) ?? r.shots.find((s) => s.after);
                  return (
                    <label key={r.id} className="pick-review">
                      <input type="checkbox" checked={picked.has(r.id)} onChange={(e) => setPicked((p) => (e.target.checked ? new Set([...p, r.id]) : new Set([...p].filter((x) => x !== r.id))))} />
                      {lead?.after && <img src={reviewImage(r.id, lead.after)} alt="" />}
                      <span>
                        <b>{r.title}</b>
                        <span className="muted"> · {reviewSummary(r)}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="faint">No before and after pictures yet. Changes Claude makes to components on the canvas get them automatically.</p>
            )}
            {unsaved > 0 && <p className="faint">{unsaved} unsaved file{unsaved === 1 ? '' : 's'} will be saved as a version first.</p>}
            <div className="actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={send}>Send for review</button>
            </div>
          </>
        )}
        {(sending || result) && (
          <>
            <ol className="steps" aria-label="Progress">
              {STEPS.map(({ step, label }) => {
                const s = steps[step];
                return (
                  <li key={step} className={s?.state ?? 'waiting'}>
                    <span className="dot" aria-hidden="true">{s?.state === 'done' ? '✓' : s?.state === 'error' ? '!' : s?.state === 'skipped' ? '–' : ''}</span>
                    <span>
                      {label}
                      {s?.detail && <span className="faint"> · {s.detail.startsWith('http') ? 'done' : s.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
            {result && <div className={result.ok ? 'ok-box' : 'error-box'}>{result.message}</div>}
            <div className="actions">
              {result?.url && (
                <button className="btn primary" onClick={() => open(result.url!)}>
                  {result.needsConfirm ? 'Finish in the browser' : 'Open the review'}
                </button>
              )}
              {result && !result.ok && <button className="btn" onClick={() => setResult(undefined)}>Back</button>}
              <button className="btn" onClick={onClose} disabled={sending}>{result ? 'Done' : 'Sending…'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
