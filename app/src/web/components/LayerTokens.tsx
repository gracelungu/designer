import type { Editor, EditorNode } from '../../../../editor/src/index.js';
import { tokensForValue, type TokenKind, type TokenPair } from '../../shared/tokenSync';
import { useTokenReport } from '../tokens';
import { useCanvasTick } from './CodePanel';
import { STATUS_LABEL } from './DesignPanel';

export interface LayerValue {
  prop: string;
  value: string | number;
  kind: TokenKind;
}

const px = (v?: string) => parseFloat(v ?? '') || 0;
const solidColor = (paints?: { type?: string; color?: string; visible?: boolean }[]) => paints?.find((f) => f.type === 'solid' && f.visible !== false && f.color)?.color;

/** The values on a layer that a token could stand for, in Figma's terms. */
export function layerValues(n: EditorNode, styles?: Record<string, string>): LayerValue[] {
  const out: LayerValue[] = [];
  const add = (prop: string, value: string | number | undefined | null, kind: TokenKind) => {
    if (value === undefined || value === null || value === '' || (typeof value === 'number' && (!isFinite(value) || value === 0))) return;
    if (!out.some((o) => o.prop === prop)) out.push({ prop, value, kind });
  };
  if (n.type === 'code' && styles) {
    const transparent = (c?: string) => !c || /rgba\([^)]*,\s*0\)$/.test(c) || c === 'transparent';
    if (!transparent(styles.backgroundColor)) add('Fill', styles.backgroundColor, 'color');
    if (px(styles.borderTopWidth) > 0 && styles.borderTopStyle !== 'none') add('Stroke', styles.borderTopColor, 'color');
    add('Text colour', styles.color, 'color');
    add('Corner radius', px(styles.borderTopLeftRadius), 'size');
    add('Font size', px(styles.fontSize), 'size');
    add('Font', (styles.fontFamily ?? '').split(',')[0].replace(/["']/g, '').trim(), 'font');
    add('Gap', px(styles.gap), 'size');
    add('Padding', px(styles.paddingTop) || px(styles.paddingLeft), 'size');
    return out;
  }
  add(n.type === 'text' ? 'Text colour' : 'Fill', solidColor(n.fills), 'color');
  add('Stroke', solidColor(n.strokes), 'color');
  add('Corner radius', n.radii?.[0] ?? n.radius, 'size');
  if (n.text) {
    add('Font size', n.text.fontSize, 'size');
    add('Font', n.text.fontFamily, 'font');
  }
  if (n.layout) {
    add('Gap', n.layout.gap, 'size');
    const p = n.layout.padding;
    add('Padding', typeof p === 'number' ? p : p ? p.t || p.l : undefined, 'size');
  }
  return out;
}

export interface LayerToken extends LayerValue {
  token?: TokenPair;
}

export function matchLayer(values: LayerValue[], pairs: TokenPair[]): LayerToken[] {
  return values.map((v) => ({ ...v, token: tokensForValue(v.value, pairs, v.kind)[0] }));
}

/** In the properties panel: which token each value on the selected layer uses, and whether Figma and code agree on it. */
export function LayerTokens({ editor, onOpenTokens }: { editor: Editor; onOpenTokens: () => void }) {
  useCanvasTick(editor);
  const { report } = useTokenReport();
  const sel = editor.store.selected();
  if (!report || sel.length !== 1) return null;
  const n = sel[0];
  const rows = matchLayer(layerValues(n, editor.code.info.get(n.id)?.styles), report.pairs);
  if (!rows.length) return null;
  const drift = rows.filter((r) => r.token?.status === 'drift').length;
  const raw = rows.filter((r) => !r.token).length;
  return (
    <div className="layer-tokens">
      <div className="section-title">
        Tokens
        <button className="btn small ghost" onClick={onOpenTokens}>All tokens</button>
      </div>
      {drift > 0 && (
        <div className="drift-banner small" role="alert">
          {drift} value{drift === 1 ? ' uses a token that differs' : 's use tokens that differ'} between Figma and code.
        </div>
      )}
      {rows.map((r) => (
        <div key={r.prop} className="kv lt-row" data-prop={r.prop}>
          <span>{r.prop}</span>
          {r.token ? (
            <span className={`lt-token ${r.token.status}`} title={`${STATUS_LABEL[r.token.status]}${r.token.figma ? ` · Figma ${r.token.figma.value}` : ''}${r.token.code ? ` · code ${r.token.code.value}` : ''}`}>
              {r.kind === 'color' && <span className="swatch" style={{ background: String(r.value) }} />}
              <span className="lt-name">{r.token.figma?.name ?? r.token.code?.name}</span>
              {r.token.status === 'drift' && <span className="tok-status drift">Differs</span>}
              {r.token.status === 'figma-only' && <span className="tok-status figma-only">Not in code</span>}
            </span>
          ) : (
            <span className="faint" title="No token has this value">
              {String(r.value)} · no token
            </span>
          )}
        </div>
      ))}
      {raw > 0 && report.pairs.length > 0 && <div className="hint">Values with no token are hard-coded. Ask Claude to use the nearest token.</div>}
    </div>
  );
}
