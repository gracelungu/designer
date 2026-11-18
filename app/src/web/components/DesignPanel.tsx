import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

interface Token {
  name: string;
  value: string;
  file: string;
  line: number;
  selector: string;
  kind: 'color' | 'size' | 'font' | 'shadow' | 'other';
}

const GROUPS: { kind: Token['kind']; label: string }[] = [
  { kind: 'color', label: 'Colours' },
  { kind: 'size', label: 'Spacing and sizes' },
  { kind: 'font', label: 'Type' },
  { kind: 'shadow', label: 'Shadows' },
  { kind: 'other', label: 'Other' },
];

/** The repo's design tokens (CSS custom properties). Editing one rewrites that declaration directly. */
export function DesignPanel({ onAsk, onChanged }: { onAsk: (text: string) => void; onChanged: () => void }) {
  const [tokens, setTokens] = useState<Token[]>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const load = () => api<Token[]>('/api/tokens').then(setTokens, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const shown = useMemo(() => (tokens ?? []).filter((t) => !filter || t.name.includes(filter) || t.value.includes(filter)), [tokens, filter]);
  const save = async (t: Token, value: string) => {
    if (value === t.value) return;
    setError('');
    try {
      setTokens(await api<Token[]>('/api/tokens', { file: t.file, line: t.line, name: t.name, value }));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!tokens) return <div className="empty">Reading tokens…</div>;
  return (
    <div className="scroll">
      <div className="section-title">
        Tokens ({tokens.length})
        <button className="btn small" onClick={load}>Reload</button>
      </div>
      {error && <div className="error-box" style={{ margin: '0 12px 8px' }}>{error}</div>}
      {tokens.length === 0 ? (
        <div className="empty">
          No CSS custom properties found in this repo's stylesheets.
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => onAsk('Look at the colours, spacing, radii and type sizes this project uses and pull the repeated raw values into CSS custom properties (design tokens) on :root, then use those tokens in place of the raw values. Keep the look identical.')}>
              Ask Claude to extract tokens
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '0 12px 8px' }}>
          <input className="input" style={{ width: '100%' }} placeholder="Filter tokens" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      {GROUPS.map((g) => {
        const list = shown.filter((t) => t.kind === g.kind);
        if (!list.length) return null;
        return (
          <div key={g.kind}>
            <div className="section-title" style={{ paddingTop: 6 }}>{g.label}</div>
            {list.map((t) => (
              <TokenRow key={`${t.file}:${t.line}:${t.name}`} token={t} onSave={(v) => save(t, v)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TokenRow({ token, onSave }: { token: Token; onSave: (v: string) => void }) {
  const [value, setValue] = useState(token.value);
  useEffect(() => setValue(token.value), [token.value]);
  const isHex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(token.value);
  const hex6 = isHex && token.value.length === 4 ? '#' + [...token.value.slice(1)].map((c) => c + c).join('') : token.value;
  return (
    <div className="row" title={`${token.file}:${token.line} · ${token.selector}`} style={{ alignItems: 'center' }}>
      {token.kind === 'color' &&
        (isHex ? (
          <input type="color" value={hex6} onChange={(e) => (setValue(e.target.value), onSave(e.target.value))} style={{ width: 22, height: 22, border: 0, padding: 0, background: 'none' }} aria-label={`${token.name} colour`} />
        ) : (
          <span style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--line)', background: token.value, flex: 'none' }} />
        ))}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{token.name}</div>
        <div className="faint" style={{ fontSize: 10.5 }}>{token.selector}</div>
      </div>
      <input
        className="input mono"
        style={{ width: 120 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSave(value.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}
