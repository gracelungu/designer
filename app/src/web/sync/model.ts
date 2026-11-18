// The two-way sync between canvas layers and code, as plain functions over the editor store.
//
// Every layer linked to code (a design layer with a codeLink, or a live component) carries a small
// record in `node.sync`:
//   base: the layer's properties the last time design and code matched (a "snapshot")
//   code: the coded component's rendered properties at that time, in the same snapshot shape
//   incoming: code changes that met a canvas edit of the same property, waiting for a decision
// Design -> code sends the difference between `base` and the layer now. Code -> design compares the
// component's render before and after a pull, and applies what moved (a three-way merge).
import { defaultLayout, solid, type EditorNode, type Store } from '../../../../editor/src/index.js';
import type { DesignChange, LayerSync } from '../../shared/protocol';
import { parseColor } from '../canvas/convert';

export type Snap = Record<string, unknown>;

export interface SyncRecord {
  base?: Snap;
  code?: Snap;
  incoming?: { to: string; changes: IncomingChange[] };
}

export interface IncomingChange {
  prop: string;
  label: string;
  mine: unknown;
  code: unknown;
}

const LABELS: Record<string, string> = {
  fill: 'Fill',
  stroke: 'Stroke',
  strokeWidth: 'Stroke width',
  radius: 'Corner radius',
  opacity: 'Opacity',
  layout: 'Auto layout',
  gap: 'Gap',
  padding: 'Padding',
  fontFamily: 'Font',
  fontSize: 'Font size',
  fontWeight: 'Font weight',
  textColor: 'Text colour',
  lineHeight: 'Line height',
  content: 'Text',
  w: 'Width',
  h: 'Height',
};

/** Properties the rendered code reports, so the only ones code can change on a design layer. */
export const CODE_KEYS = ['fill', 'stroke', 'strokeWidth', 'radius', 'opacity', 'layout', 'gap', 'padding', 'fontFamily', 'fontSize', 'fontWeight', 'textColor', 'lineHeight'];

export const labelFor = (prop: string) => (prop.startsWith('arg:') ? `Prop ${prop.slice(4)}` : (LABELS[prop] ?? prop));

const round = (v: number) => Math.round(v * 100) / 100;

const hexOf = (paints: { type: string; color?: string; opacity?: number; visible?: boolean }[] | undefined): string | null => {
  const f = (paints ?? []).find((p) => p.visible !== false && p.type === 'solid');
  if (!f || !f.color) return null;
  const c = f.color.toUpperCase();
  return f.opacity !== undefined && f.opacity < 1 ? `${c}${Math.round(f.opacity * 255).toString(16).padStart(2, '0').toUpperCase()}` : c;
};

/** A colour from CSS (or the canvas) as #RRGGBB, with #RRGGBBAA when see-through; null when invisible. */
export function cssColor(v: string | undefined | null): string | null {
  const c = parseColor(v ?? undefined);
  if (!c || c.opacity <= 0) return null;
  return c.opacity < 1 ? `${c.color}${Math.round(c.opacity * 255).toString(16).padStart(2, '0').toUpperCase()}` : c.color;
}

const sameAll = (a: number[]) => a.every((x) => x === a[0]);
const fourOrOne = (a: number[]) => (sameAll(a) ? a[0] : a);

/** True for layers that sync with code. */
export function isLinked(n: EditorNode | undefined): n is EditorNode {
  if (!n) return false;
  if (n.type === 'code') return n.code?.kind === 'component' && !!(n.code.storyId || n.code.file);
  return !!(n.codeLink && (n.codeLink.storyId || n.codeLink.file));
}

export function syncOf(n: EditorNode): SyncRecord {
  return (n.sync ?? {}) as SyncRecord;
}

/** The first text layer inside a layer (depth first): the label of a button, the title of a card. */
export function firstText(store: Store, n: EditorNode): EditorNode | undefined {
  if (n.type === 'text') return n;
  for (const id of n.children ?? []) {
    const c = store.get(id);
    if (!c || c.visible === false) continue;
    const t = firstText(store, c);
    if (t) return t;
  }
  return undefined;
}

/** A layer's syncable properties. For a live component: its props. */
export function snapshot(store: Store, n: EditorNode): Snap {
  if (n.type === 'code') {
    const out: Snap = {};
    for (const [k, v] of Object.entries(n.code?.args ?? {})) out[`arg:${k}`] = v;
    return out;
  }
  const s: Snap = {};
  if (n.type !== 'text') {
    s.fill = hexOf(n.fills);
    s.stroke = hexOf(n.strokes);
    if (s.stroke) s.strokeWidth = n.strokeWidth;
    s.radius = n.radii ? fourOrOne(n.radii.map(round)) : round(n.radius ?? 0);
  }
  s.opacity = round(n.opacity ?? 1);
  if (n.layout) {
    s.layout = n.layout.mode;
    s.gap = n.layout.gap ?? 0;
    const p = n.layout.padding ?? { t: 0, r: 0, b: 0, l: 0 };
    s.padding = fourOrOne([p.t, p.r, p.b, p.l]);
  }
  if (n.sizing?.h === 'fixed' && !(n.type === 'text' && n.text?.autoResize === 'width')) s.w = Math.round(n.w);
  if (n.sizing?.v === 'fixed' && !(n.type === 'text' && n.text?.autoResize !== 'fixed')) s.h = Math.round(n.h);
  const t = firstText(store, n);
  if (t) {
    s.content = t.text.content;
    s.fontFamily = t.text.fontFamily;
    s.fontSize = t.text.fontSize;
    s.fontWeight = t.text.fontWeight;
    s.textColor = hexOf(t.fills);
    if (t.text.lineHeight) s.lineHeight = t.text.lineHeight;
  }
  return s;
}

const px = (v: string | undefined) => (v ? round(parseFloat(v) || 0) : 0);

/** A component's rendered styles (from the probe in its live frame) in the same shape as a layer snapshot. */
export function stylesToSnap(st: Record<string, string>): Snap {
  const s: Snap = {};
  s.fill = cssColor(st.backgroundColor);
  const bw = px(st.borderTopWidth);
  s.stroke = bw > 0 && st.borderTopStyle !== 'none' ? cssColor(st.borderTopColor) : null;
  if (s.stroke) s.strokeWidth = bw;
  s.radius = fourOrOne([st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomRightRadius, st.borderBottomLeftRadius].map(px));
  if (st.opacity !== undefined) s.opacity = round(Number(st.opacity));
  if (/flex/.test(st.display ?? '')) {
    s.layout = st.flexDirection?.startsWith('column') ? 'vertical' : 'horizontal';
    s.gap = px(st.gap);
    s.padding = fourOrOne([st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft].map(px));
  }
  if (st.fontFamily) s.fontFamily = st.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  if (st.fontSize) s.fontSize = px(st.fontSize);
  if (st.fontWeight) s.fontWeight = Number(st.fontWeight) || 400;
  s.textColor = cssColor(st.color);
  if (st.lineHeight && st.lineHeight !== 'normal') s.lineHeight = px(st.lineHeight);
  return s;
}

const norm = (v: unknown) => (v === undefined || v === '' ? null : typeof v === 'string' && /^#[0-9a-f]{6,8}$/i.test(v) ? v.toUpperCase() : v);
export const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function cssOf(prop: string, v: unknown): string | undefined {
  const n = norm(v);
  const len = (x: unknown) => (Array.isArray(x) ? x.map((y) => `${y}px`).join(' ') : `${x}px`);
  switch (prop) {
    case 'fill':
      return `background-color: ${n ?? 'transparent'}`;
    case 'stroke':
      return n ? `border-color: ${n}` : 'border: none';
    case 'strokeWidth':
      return `border-width: ${len(n)}`;
    case 'radius':
      return `border-radius: ${len(n ?? 0)}`;
    case 'opacity':
      return `opacity: ${n}`;
    case 'layout':
      return `display: flex; flex-direction: ${n === 'vertical' ? 'column' : 'row'}`;
    case 'gap':
      return `gap: ${len(n ?? 0)}`;
    case 'padding':
      return `padding: ${len(n ?? 0)}`;
    case 'fontFamily':
      return `font-family: ${n}`;
    case 'fontSize':
      return `font-size: ${len(n)}`;
    case 'fontWeight':
      return `font-weight: ${n}`;
    case 'textColor':
      return `color: ${n}`;
    case 'lineHeight':
      return `line-height: ${len(n)}`;
    case 'w':
      return `width: ${len(n)}`;
    case 'h':
      return `height: ${len(n)}`;
    default:
      return undefined;
  }
}

/** What changed from `a` to `b`, in design terms, limited to `keys` when given. */
export function diffSnap(a: Snap, b: Snap, keys?: string[]): DesignChange[] {
  const all = keys ?? [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const out: DesignChange[] = [];
  for (const k of all) {
    if (same(a[k], b[k])) continue;
    out.push({ prop: k, label: labelFor(k), from: norm(a[k]), to: norm(b[k]), css: cssOf(k, b[k]) });
  }
  return out;
}

/** Linked layers without a baseline get one: the moment they were linked is when design and code matched. */
export function ensureBaselines(store: Store): string[] {
  const made: string[] = [];
  for (const id of store.allIds()) {
    const n = store.get(id);
    if (!isLinked(n) || syncOf(n).base) continue;
    n.sync = { ...syncOf(n), base: snapshot(store, n) };
    made.push(id);
  }
  return made;
}

/** Linked layers whose canvas properties moved away from the code, with what moved. */
export function pendingChanges(store: Store): LayerSync[] {
  const out: LayerSync[] = [];
  for (const id of store.allIds()) {
    const n = store.get(id);
    if (!isLinked(n)) continue;
    const base = syncOf(n).base;
    if (!base) continue;
    const changes = diffSnap(base, snapshot(store, n));
    if (!changes.length) continue;
    out.push(layerSync(n, changes));
  }
  return out;
}

export function layerSync(n: EditorNode, changes: DesignChange[]): LayerSync {
  if (n.type === 'code') return { layerId: n.id, name: n.name, kind: 'component', storyId: n.code?.storyId, file: n.code?.file, changes };
  return { layerId: n.id, name: n.name, kind: 'design', storyId: n.codeLink?.storyId, file: n.codeLink?.file, exportName: n.codeLink?.exportName, changes };
}

/** After code took these changes, they become the new common ground (later canvas edits stay pending). */
export function acceptChanges(store: Store, layers: LayerSync[]) {
  for (const l of layers) {
    const n = store.get(l.layerId);
    if (!n) continue;
    const base = { ...(syncOf(n).base ?? {}) };
    for (const c of l.changes) base[c.prop] = c.to;
    n.sync = { ...syncOf(n), base };
  }
}

const pad4 = (p: unknown) => {
  const a = Array.isArray(p) ? (p as number[]) : [Number(p ?? 0)];
  const [t = 0, r = t, b = t, l = r] = a;
  return { t, r, b, l };
};

/** Sets snapshot properties on a layer (call inside store.transact). */
export function applySnap(store: Store, n: EditorNode, patch: Snap) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
  if (n.type === 'code') {
    const args = { ...(n.code?.args ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (!k.startsWith('arg:')) continue;
      if (v === undefined || v === null) delete args[k.slice(4)];
      else args[k.slice(4)] = v;
    }
    if (n.code) n.code.args = args;
    return;
  }
  const paint = (v: unknown) => {
    const c = parseColor(typeof v === 'string' ? v : undefined);
    return c ? [solid(c.color, c.opacity)] : [];
  };
  if (n.type !== 'text') {
    if (has('fill')) n.fills = paint(patch.fill);
    if (has('stroke')) n.strokes = paint(patch.stroke);
    if (has('strokeWidth') && patch.strokeWidth !== null) n.strokeWidth = Number(patch.strokeWidth);
    if (has('radius')) {
      const r = patch.radius;
      if (Array.isArray(r)) {
        n.radii = r as number[];
        n.radius = (r as number[])[0];
      } else {
        n.radius = Number(r ?? 0);
        n.radii = null;
      }
    }
  }
  if (has('opacity') && patch.opacity !== null) n.opacity = Number(patch.opacity);
  if ((has('layout') || has('gap') || has('padding')) && (n.type === 'frame' || n.type === 'section')) {
    if (has('layout') && !patch.layout) n.layout = null;
    else {
      if (!n.layout) n.layout = { ...defaultLayout(String(patch.layout ?? 'horizontal')) };
      if (has('layout') && patch.layout) n.layout.mode = patch.layout;
      if (has('gap')) n.layout.gap = Number(patch.gap ?? 0);
      if (has('padding')) n.layout.padding = pad4(patch.padding);
    }
  }
  if (has('w') && patch.w !== null) n.w = Number(patch.w);
  if (has('h') && patch.h !== null) n.h = Number(patch.h);
  const t = firstText(store, n);
  if (t) {
    if (has('content') && patch.content !== null) t.text.content = String(patch.content);
    if (has('fontFamily') && patch.fontFamily) t.text.fontFamily = String(patch.fontFamily);
    if (has('fontSize') && patch.fontSize) t.text.fontSize = Number(patch.fontSize);
    if (has('fontWeight') && patch.fontWeight) t.text.fontWeight = Number(patch.fontWeight);
    if (has('lineHeight')) t.text.lineHeight = patch.lineHeight ? Number(patch.lineHeight) : null;
    if (has('textColor') && patch.textColor) t.fills = paint(patch.textColor);
  }
}

/**
 * Three-way merge of a code change into a design layer. `codeBefore` and `codeAfter` are the
 * component's render before and after the change; `base` is where design and code last matched,
 * `current` is the layer now. Properties only code moved are applied; properties both sides moved
 * (differently) are conflicts. Without `codeBefore` there is nothing to tell what code changed, so
 * every difference becomes a question.
 */
export function mergeFromCode(o: { base?: Snap; current: Snap; codeBefore?: Snap; codeAfter: Snap }) {
  const apply: Snap = {};
  const conflicts: IncomingChange[] = [];
  const keys = CODE_KEYS.filter((k) => k in o.codeAfter || (o.codeBefore && k in o.codeBefore));
  for (const k of keys) {
    const theirs = o.codeAfter[k];
    if (same(o.current[k], theirs)) continue;
    if (!o.codeBefore) {
      // Text styles of a layer with no text, or padding of a layer with no auto layout: nothing to compare.
      if (!(k in o.current)) continue;
      conflicts.push({ prop: k, label: labelFor(k), mine: norm(o.current[k]), code: norm(theirs) });
      continue;
    }
    if (same(o.codeBefore[k], theirs)) continue; // code didn't move this one
    const untouched = !o.base || same(o.base[k], o.current[k]);
    if (untouched) apply[k] = theirs;
    else conflicts.push({ prop: k, label: labelFor(k), mine: norm(o.current[k]), code: norm(theirs) });
  }
  return { apply, conflicts };
}

/** Linked layers that render a story, so their code can be measured. */
export function measurableLayers(store: Store): EditorNode[] {
  return store
    .allIds()
    .map((id) => store.get(id)!)
    .filter((n) => n.type !== 'code' && isLinked(n) && !!n.codeLink?.storyId);
}

/** Changed files that probably belong to a linked layer: its story file, or files next to it named like the component. */
export function filesFor(n: EditorNode, files: string[]): string[] {
  const own = n.type === 'code' ? n.code?.file : n.codeLink?.file;
  if (!own) return [];
  const norm = (f: string) => f.replace(/\\/g, '/');
  const o = norm(own);
  const dir = o.includes('/') ? o.slice(0, o.lastIndexOf('/') + 1) : '';
  const base = o.slice(dir.length).split('.')[0];
  return files.filter((f) => {
    const x = norm(f);
    return x === o || (x.startsWith(dir) && !x.slice(dir.length).includes('/') && x.slice(dir.length).split('.')[0] === base);
  });
}
