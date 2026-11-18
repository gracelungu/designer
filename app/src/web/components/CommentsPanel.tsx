import { useCallback, useEffect, useState } from 'react';
import type { CanvasComment, PullRequestSummary, ReviewStatus, ReviewThread } from '../../shared/protocol';
import { api } from '../api';

/**
 * The team's feedback in one place: comments pinned on the canvas (saved in the repo, so they
 * arrive with Get latest), and the comments on the project's pull requests (GitHub or Azure DevOps).
 */
export function CommentsPanel({
  comments,
  layerName,
  hasProject,
  onOpen,
  onAsk,
  onAddComment,
  onOpenUrl,
}: {
  comments: CanvasComment[];
  layerName: (id: string | null) => string | undefined;
  hasProject: boolean;
  onOpen: (id: string) => void;
  onAsk: (prompt: string) => void;
  onAddComment: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const [view, setView] = useState<'canvas' | 'prs'>('canvas');
  const [showResolved, setShowResolved] = useState(false);
  const open = comments.filter((c) => !c.resolved);
  const shown = (showResolved ? comments : open).slice().sort((a, b) => a.num - b.num);
  return (
    <div className="comments-panel" data-canvas-keys="off">
      <div className="side-switch">
        <div className="segmented full" role="tablist" aria-label="Comments">
          <button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'on' : ''} onClick={() => setView('canvas')}>
            On the canvas {open.length > 0 && <span className="badge dark">{open.length}</span>}
          </button>
          <button role="tab" aria-selected={view === 'prs'} className={view === 'prs' ? 'on' : ''} onClick={() => setView('prs')}>
            Pull requests
          </button>
        </div>
      </div>
      {view === 'canvas' ? (
        <div className="scroll">
          <div className="cp-bar">
            <button className="btn small" onClick={onAddComment}>Add comment (C)</button>
            <label className="cp-toggle">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
            </label>
          </div>
          {!shown.length && (
            <div className="empty">
              {comments.length ? 'Every comment is resolved.' : 'No comments yet. Press C and click a frame to pin one.'}
              {hasProject ? ' Comments are saved in the project, so the team sees them after Get latest.' : ''}
            </div>
          )}
          {shown.map((c) => {
            const on = layerName(c.nodeId);
            return (
              <div key={c.id} className={`cp-item ${c.resolved ? 'resolved' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}>
                <span className="cp-num">{c.num}</span>
                <div className="cp-body">
                  <div className="cp-meta">
                    <b>{c.author}</b>
                    {on && <span> on {on}</span>}
                    {c.resolved && <span> · resolved</span>}
                  </div>
                  <div className="cp-text">{c.text}</div>
                  {c.replies.length > 0 && <div className="cp-meta">{c.replies.length === 1 ? '1 reply' : `${c.replies.length} replies`}</div>}
                </div>
                {!c.resolved && (
                  <button
                    className="btn small ghost"
                    title="Ask Claude to make this change"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAsk(`Address canvas comment #${c.num}${on ? ` on "${on}"` : ''}: "${c.text}". Make the change, then reply to the comment with what you did and resolve it.`);
                    }}
                  >
                    Fix with Claude
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <PullRequests hasProject={hasProject} onAsk={onAsk} onOpenUrl={onOpenUrl} />
      )}
    </div>
  );
}

function PullRequests({ hasProject, onAsk, onOpenUrl }: { hasProject: boolean; onAsk: (p: string) => void; onOpenUrl: (url: string) => void }) {
  const [status, setStatus] = useState<ReviewStatus>();
  const [prs, setPrs] = useState<PullRequestSummary[]>();
  const [pr, setPr] = useState<PullRequestSummary>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!hasProject) return;
    setError('');
    setLoading(true);
    try {
      const s = await api<ReviewStatus>('/api/reviews/status');
      setStatus(s);
      if (s.ready) setPrs(await api<PullRequestSummary[]>('/api/reviews'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [hasProject]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!hasProject) return <div className="empty">Add a project to see its pull requests and their comments.</div>;
  if (pr) return <PullRequestThreads pr={pr} host={status?.host ?? null} onBack={() => setPr(undefined)} onAsk={onAsk} onOpenUrl={onOpenUrl} />;
  return (
    <div className="scroll">
      <div className="cp-bar">
        <span className="muted">{status?.host === 'azure' ? `Azure DevOps · ${status.project}/${status.repo}` : status?.host === 'github' ? 'GitHub' : ''}</span>
        <button className="btn small" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <div className="error-box" style={{ margin: '0 12px 8px' }}>{error}</div>}
      {status && !status.ready && <div className="empty">{status.problem}</div>}
      {status?.ready && prs && !prs.length && <div className="empty">No open pull requests. Share for review opens one with your saved versions.</div>}
      {prs?.map((p) => (
        <div key={p.id} className="cp-item" role="button" tabIndex={0} onClick={() => setPr(p)} onKeyDown={(e) => e.key === 'Enter' && setPr(p)}>
          <span className="cp-num pr">#{p.id}</span>
          <div className="cp-body">
            <div className="cp-text">{p.title}</div>
            <div className="cp-meta">
              {p.author} · {p.branch} → {p.target}
              {p.draft ? ' · draft' : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PullRequestThreads({ pr, host, onBack, onAsk, onOpenUrl }: { pr: PullRequestSummary; host: ReviewStatus['host']; onBack: () => void; onAsk: (p: string) => void; onOpenUrl: (url: string) => void }) {
  const [threads, setThreads] = useState<ReviewThread[]>();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<ReviewThread[]>(`/api/reviews/threads?pr=${pr.id}`).then(setThreads, (e: Error) => setError(e.message));
  }, [pr.id]);
  const act = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setError('');
    try {
      setThreads(await api<ReviewThread[]>(path, body));
      setDraft((d) => ({ ...d, [key]: '' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const replyBox = (key: string, threadId?: string) => (
    <div className="cp-reply">
      <textarea className="input" rows={2} placeholder={threadId ? 'Reply' : 'Add a comment to this pull request'} value={draft[key] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
      <button className="btn small primary" disabled={!draft[key]?.trim() || busy === key} onClick={() => void act(key, '/api/reviews/reply', { pr: pr.id, threadId, text: draft[key] })}>
        {busy === key ? 'Sending…' : threadId ? 'Reply' : 'Comment'}
      </button>
    </div>
  );
  return (
    <div className="scroll">
      <div className="cp-bar">
        <button className="chat-back" onClick={onBack}>‹ All pull requests</button>
        <button className="btn small" onClick={() => onOpenUrl(pr.url)}>Open</button>
      </div>
      <div className="cp-pr-title">
        <b>#{pr.id} {pr.title}</b>
        <div className="cp-meta">{pr.author} · {pr.branch} → {pr.target}</div>
      </div>
      {error && <div className="error-box" style={{ margin: '0 12px 8px' }}>{error}</div>}
      {!threads && !error && <div className="empty">Loading comments…</div>}
      {threads && !threads.length && <div className="empty">No comments yet.</div>}
      {threads?.map((t) => (
        <div key={t.id} className={`cp-thread ${t.resolved ? 'resolved' : ''}`}>
          {t.file && (
            <div className="cp-meta mono">
              {t.file}
              {t.line ? `:${t.line}` : ''}
            </div>
          )}
          {t.comments.map((c) => (
            <div key={c.id} className="cp-msg">
              <b>{c.author}</b> <span className="cp-text">{c.text}</span>
            </div>
          ))}
          <div className="cp-actions">
            {!t.resolved && (
              <button className="btn small ghost" onClick={() => onAsk(`On pull request #${pr.id} ("${pr.title}"), address this review comment${t.file ? ` on ${t.file}${t.line ? `:${t.line}` : ''}` : ''}: "${t.comments[0]?.text ?? ''}". Make the change on the PR's branch (${pr.branch}), then reply in the thread with what you did.`)}>
                Fix with Claude
              </button>
            )}
            {host === 'azure' && (
              <button className="btn small ghost" disabled={busy === `r${t.id}`} onClick={() => void act(`r${t.id}`, '/api/reviews/resolve', { pr: pr.id, threadId: t.id, resolved: !t.resolved })}>
                {t.resolved ? 'Reopen' : 'Resolve'}
              </button>
            )}
          </div>
          {replyBox(t.id, t.id)}
        </div>
      ))}
      {threads && <div className="cp-thread">{replyBox('new')}</div>}
    </div>
  );
}
