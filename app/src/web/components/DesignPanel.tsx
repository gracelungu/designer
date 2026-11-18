import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { loadTokens, tokenAction, useTokenReport } from '../tokens';
import type { PairStatus, TokenKind, TokenPair } from '../../shared/tokenSync';

const GROUPS: { kind: TokenKind; label: string }[] = [
  { kind: 'color', label: 'Colours' },
  { kind: 'size', label: 'Spacing and sizes' },
  { kind: 'font', label: 'Type' },
  { kind: 'shadow', label: 'Shadows' },
  { kind: 'other', label: 'Other' },
];

type Filter = 'all' | PairStatus;

export const STATUS_LABEL: Record<PairStatus, string> = {
  'in-sync': 'In sync',
  drift: 'Differs',
  'figma-only': 'Only in Figma',
  'code-only': 'Only in code',
};

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const modeLabel = (p: TokenPair) => (p.mode ? ` (${p.mode})` : '');

/**
 * The repo's design tokens next to the Figma variables, as one list: what is in sync, what differs,
 * and what exists on one side only. Code tokens can be edited in place; drift can be fixed by
 * taking Figma's value (written straight into the CSS or Tailwind config).
 */
export function DesignPanel({ onAsk, onChanged }: { onAsk: (text: string) => void; onChanged: () => void }) {
  const { report, error: loadError } = useTokenReport();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (label: string, fn: () => Promise<unknown>, changed = false) => {
    setError('');
    setBusy(label);
    try {
      await fn();
      if (changed) onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const pairs = useMemo(() => report?.pairs ?? [], [report]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pairs.filter(
      (p) =>
        (filter === 'all' || p.status === filter) &&
        (!q || [p.figma?.name, p.figma?.value, p.code?.name, p.code?.value].some((x) => x?.toLowerCase().includes(q))),
    );
  }, [pairs, filter, query]);
  const unlinkedCode = pairs.filter((p) => p.status === 'code-only').map((p) => p.code!);

  if (!report) return <div className="empty">{loadError || 'Reading tokens…'}</div>;
  const s = report.summary;
  const drift = pairs.filter((p) => p.status === 'drift');
  const fixable = drift.filter((p) => !/var\(/.test(p.code!.value) && !(p.mode && /dark|night/i.test(p.mode) && !/dark/i.test(p.code!.selector)));

  const takeFigma = (keys: string[]) => run('use-figma', () => tokenAction('/api/tokens/sync/use-figma', { keys }), true);
  const editCode = (p: TokenPair, value: string) =>
    run(
      'edit',
      async () => {
        await api('/api/tokens', { file: p.code!.file, line: p.code!.line, name: p.code!.name, value });
        await loadTokens();
      },
      true,
    );

  return (
    <div className="scroll tokens-panel">
      <div className="tok-source">
        {report.figma ? (
          <span>
            <b>Figma</b> · {report.figma.count} variables, {report.figma.source === 'figma-desktop' ? 'pulled from the desktop app' : 'imported'} {ago(report.figma.pulledAt)}
          </span>
        ) : (
          <span>
            <b>No Figma variables yet.</b> Pull them from the Figma desktop app (select the frames that use them), or import a variables file.
          </span>
        )}
        <div className="row-actions">
          <button className="btn small primary" disabled={!!busy} onClick={() => run('pull', () => tokenAction('/api/tokens/sync/figma', {}))}>
            {busy === 'pull' ? 'Pulling…' : 'Pull from Figma'}
          </button>
          <button className="btn small" disabled={!!busy} onClick={() => fileRef.current?.click()} title="Figma REST variables JSON, W3C design tokens or Tokens Studio">
            Import file…
          </button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => run('reload', loadTokens)}>
            Reload
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Figma variables file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run('import', async () => tokenAction('/api/tokens/sync/import', { text: await f.text() }));
            }}
          />
        </div>
      </div>

      {(error || loadError) && <div className="error-box" style={{ margin: '0 12px 8px' }}>{error || loadError}</div>}

      {s.drift > 0 && (
        <div className="drift-banner" role="alert">
          <b>
            {s.drift} token{s.drift === 1 ? '' : 's'} differ{s.drift === 1 ? 's' : ''} between Figma and code.
          </b>
          <div className="row-actions">
            {fixable.length > 0 && (
              <button className="btn small" disabled={!!busy} onClick={() => takeFigma(fixable.map((p) => p.key))}>
                Use Figma for {fixable.length === drift.length ? 'all' : `${fixable.length}`}
              </button>
            )}
            <button className="btn small ghost" onClick={() => onAsk(`Fix the drift between Figma and code. Read it with get_design_tokens (status drift). Figma is the source of truth unless a value is clearly a mistake there; tell me which ones you think are. Change the tokens in code, not the components that use them.`)}>
              Ask Claude
            </button>
          </div>
        </div>
      )}

      <div className="tok-filters" role="tablist" aria-label="Show tokens">
        {(
          [
            ['all', 'All', pairs.length],
            ['drift', 'Differs', s.drift],
            ['figma-only', 'Only in Figma', s.figmaOnly],
            ['code-only', 'Only in code', s.codeOnly],
            ['in-sync', 'In sync', s.inSync],
          ] as [Filter, string, number][]
        ).map(([f, label, n]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`tok-filter ${filter === f ? 'on' : ''} ${f}`} onClick={() => setFilter(f)}>
            {label} <span className="n">{n}</span>
          </button>
        ))}
      </div>

      {pairs.length === 0 ? (
        <div className="empty">
          No tokens in this repo's stylesheets or Tailwind config yet.
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => onAsk('Look at the colours, spacing, radii and type sizes this project uses and pull the repeated raw values into CSS custom properties (design tokens) on :root, then use those tokens in place of the raw values. Keep the look identical.')}>
              Ask Claude to extract tokens
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '0 12px 8px' }}>
          <input className="input" style={{ width: '100%' }} placeholder="Filter tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}

      {filter === 'figma-only' && s.figmaOnly > 0 && (
        <div className="hint">
          <button className="btn small" onClick={() => onAsk(`Add the Figma variables that are missing in code as design tokens, following this repo's existing token files and naming. List them with get_design_tokens (status figma-only). Then check they show as in sync.`)}>
            Ask Claude to add all {s.figmaOnly} to code
          </button>
        </div>
      )}

      {GROUPS.map((g) => {
        const list = shown.filter((p) => p.kind === g.kind);
        if (!list.length) return null;
        return (
          <div key={g.kind}>
            <div className="section-title" style={{ paddingTop: 6 }}>{g.label}</div>
            {list.map((p) => (
              <TokenRow
                key={p.key}
                pair={p}
                busy={!!busy}
                candidates={unlinkedCode.filter((c) => c.kind === p.kind)}
                onUseFigma={() => takeFigma([p.key])}
                onEdit={(v) => editCode(p, v)}
                onLink={(code) => run('link', () => tokenAction('/api/tokens/sync/link', { figma: p.figma!.name, code }))}
                onAsk={onAsk}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Swatch({ value }: { value: string }) {
  return <span className="swatch" style={{ background: value }} />;
}

function TokenRow({
  pair: p,
  busy,
  candidates,
  onUseFigma,
  onEdit,
  onLink,
  onAsk,
}: {
  pair: TokenPair;
  busy: boolean;
  candidates: NonNullable<TokenPair['code']>[];
  onUseFigma: () => void;
  onEdit: (value: string) => void;
  onLink: (code: string | null) => void;
  onAsk: (text: string) => void;
}) {
  const [value, setValue] = useState(p.code?.value ?? '');
  const [prev, setPrev] = useState(p.code?.value);
  if (prev !== p.code?.value) {
    setPrev(p.code?.value);
    setValue(p.code?.value ?? '');
  }
  const c = p.code;
  const editable = c && c.source === 'css';
  const save = () => c && value.trim() && value.trim() !== c.value && onEdit(value.trim());
  const darkWithoutOverride = c && p.mode && /dark|night/i.test(p.mode) && !/dark/i.test(c.selector);
  const pointer = c && /var\(/.test(c.value);
  return (
    <div className={`tok-row ${p.status}`} data-key={p.key} title={c ? `${c.file}:${c.line} · ${c.selector}` : p.figma?.collection}>
      <div className="tok-names">
        <span className={`tok-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
        {p.figma && (
          <span className="tok-figma" title="Figma variable">
            {p.figma.name}
            {modeLabel(p)}
          </span>
        )}
        {c && <span className="tok-code mono">{c.name}</span>}
        {p.match === 'linked' && (
          <button className="link-btn small" onClick={() => onLink(null)} title="Stop pairing these two">
            Unlink
          </button>
        )}
      </div>
      <div className="tok-values">
        {p.figma && (
          <span className="tok-val" title="Figma value">
            {p.kind === 'color' && <Swatch value={p.figma.value} />}
            <span className="tok-side">Figma</span> <span className="mono">{p.figma.value}</span>
          </span>
        )}
        {c && (
          <span className="tok-val" title="Code value">
            {p.kind === 'color' && <Swatch value={c.resolved ?? c.value} />}
            <span className="tok-side">Code</span>
            {editable ? (
              <input
                className="input mono tok-input"
                aria-label={`${c.name} value`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <span className="mono">{c.value}</span>
            )}
            {c.source === 'tailwind' && <span className="faint">tailwind</span>}
          </span>
        )}
      </div>
      {p.status === 'drift' && (
        <div className="row-actions">
          {darkWithoutOverride || pointer ? (
            <button className="btn small" onClick={() => onAsk(`In code, ${c!.name} should be ${p.figma!.value}${p.mode ? ` in ${p.mode} mode` : ''} to match the Figma variable "${p.figma!.name}". ${pointer ? `It points at another token (${c!.value}); decide whether to change that token or point it elsewhere.` : `There is no ${p.mode} override in code yet; add one the way this repo does themes.`}`)}>
              Ask Claude to fix
            </button>
          ) : (
            <button className="btn small" disabled={busy} onClick={onUseFigma}>
              Use Figma value
            </button>
          )}
          <button className="btn small ghost" onClick={() => void navigator.clipboard?.writeText(c!.value)} title="Figma's desktop server can't change variables. Copy the code value and paste it into Figma, then pull again.">
            Copy code value
          </button>
        </div>
      )}
      {p.status === 'figma-only' && (
        <div className="row-actions">
          <button className="btn small" onClick={() => onAsk(`Add the Figma variable "${p.figma!.name}"${p.mode ? ` (${p.mode} mode)` : ''} = ${p.figma!.value} to this repo as a design token, next to the existing tokens and following their naming. Then check get_design_tokens shows it in sync.`)}>
            Add to code
          </button>
          {candidates.length > 0 && (
            <select className="input tok-link" aria-label={`Link ${p.figma!.name} to a code token`} value="" disabled={busy} onChange={(e) => e.target.value && onLink(e.target.value)}>
              <option value="">Link to a code token…</option>
              {candidates.map((t) => (
                <option key={`${t.file}:${t.line}:${t.name}`} value={t.name}>
                  {t.name} = {t.value}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
