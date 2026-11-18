// Turns Claude's simple layer descriptions into editable canvas layers, and canvas layers back
// into descriptions Claude can read.
import { defaultLayout, shadow, solid, type EditorNode, type Store } from '../../../../editor/src/index.js';
import type { CanvasState, SimpleNode } from '../../shared/protocol';

/** '#rgb', '#rrggbb', '#rrggbbaa', 'rgb()' or 'rgba()' to a hex colour and an opacity. */
export function parseColor(c: string | undefined): { color: string; opacity: number } | null {
  if (!c) return null;
  const s = c.trim();
  if (s === 'none' || s === 'transparent') return null;
  let m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) return { color: `#${m[1].split('').map((x) => x + x).join('')}`.toUpperCase(), opacity: 1 };
  m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return { color: `#${m[1]}`.toUpperCase(), opacity: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1 };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const hex = [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('');
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { color: `#${hex}`.toUpperCase(), opacity: a };
  }
  return null;
}

const pad4 = (p: number | number[] | undefined) => {
  if (p === undefined) return { t: 0, r: 0, b: 0, l: 0 };
  if (typeof p === 'number') return { t: p, r: p, b: p, l: p };
  const [t = 0, r = t, b = t, l = r] = p;
  return { t, r, b, l };
};

const TYPE: Record<string, string> = { frame: 'frame', group: 'group', rect: 'rect', ellipse: 'ellipse', line: 'line', text: 'text', image: 'image', component: 'code' };

/** Applies the style fields of a simple layer to an editor node (used for both create and update). */
export function applySimple(store: Store, n: EditorNode, s: Partial<SimpleNode>) {
  if (s.name !== undefined) n.name = s.name;
  if (s.w !== undefined) n.w = Math.max(0, s.w);
  if (s.h !== undefined) n.h = Math.max(0, s.h);
  if (s.opacity !== undefined) n.opacity = s.opacity;
  if (s.rotation !== undefined) n.rotation = s.rotation;
  if (s.clip !== undefined) n.clip = s.clip;
  if (s.fill !== undefined) {
    const c = parseColor(s.fill);
    if (n.type === 'text') {
      if (c) n.fills = [solid(c.color, c.opacity)];
    } else n.fills = c ? [solid(c.color, c.opacity)] : [];
  }
  if (s.stroke !== undefined) {
    const c = parseColor(s.stroke);
    n.strokes = c ? [solid(c.color, c.opacity)] : [];
  }
  if (s.strokeWidth !== undefined) n.strokeWidth = s.strokeWidth;
  if (s.radius !== undefined) {
    if (Array.isArray(s.radius)) {
      n.radii = s.radius;
      n.radius = s.radius[0];
    } else {
      n.radius = s.radius;
      n.radii = null;
    }
  }
  if (s.shadow) {
    const c = parseColor(s.shadow.color) ?? { color: '#000000', opacity: 0.25 };
    n.effects = [{ ...shadow('drop-shadow'), x: s.shadow.x ?? 0, y: s.shadow.y ?? 4, blur: s.shadow.blur ?? 8, spread: s.shadow.spread ?? 0, color: c.color, opacity: s.shadow.opacity ?? c.opacity }];
  }
  if (s.text && n.type === 'text') {
    const t = s.text;
    Object.assign(n.text, {
      content: t.content ?? n.text.content,
      ...(t.fontFamily && { fontFamily: t.fontFamily }),
      ...(t.fontSize && { fontSize: t.fontSize }),
      ...(t.fontWeight && { fontWeight: t.fontWeight }),
      ...(t.align && { align: t.align }),
      ...(t.lineHeight && { lineHeight: t.lineHeight }),
      ...(t.letterSpacing !== undefined && { letterSpacing: t.letterSpacing }),
      ...(t.italic !== undefined && { italic: t.italic }),
    });
    const c = parseColor(t.color);
    if (c) n.fills = [solid(c.color, c.opacity)];
    if (s.w !== undefined && n.text.autoResize === 'width') n.text.autoResize = 'height';
  }
  if (s.layout && (n.type === 'frame' || n.type === 'section')) {
    const L = s.layout;
    n.layout = { ...defaultLayout(L.mode), gap: L.gap ?? 0, padding: pad4(L.padding), primary: L.align ?? 'start', counter: L.counterAlign === 'stretch' ? 'start' : (L.counterAlign ?? 'start') };
    if (!s.sizing) n.sizing = { h: s.w === undefined ? 'hug' : 'fixed', v: s.h === undefined ? 'hug' : 'fixed' };
  }
  if (s.sizing) n.sizing = { h: s.sizing.h ?? n.sizing?.h ?? 'fixed', v: s.sizing.v ?? n.sizing?.v ?? 'fixed' };
  if (s.imageUrl && n.type === 'image') {
    const id = `a${Math.random().toString(36).slice(2, 10)}`;
    store.assets[id] = s.imageUrl;
    n.fills = [{ type: 'image', asset: id, fit: 'fill', opacity: 1, visible: true }];
  }
  if (s.codeLink) n.codeLink = s.codeLink;
  if (n.type === 'code' && n.code && s.args) n.code.args = { ...s.args };
}

/**
 * Builds layers from simple descriptions. Children's x/y are relative to their parent.
 * `storySrc` gives the live URL for component layers. Returns the new top-level ids.
 */
export function buildNodes(store: Store, list: SimpleNode[], storySrc: Record<string, string>, parentId: string | null = null, ox = 0, oy = 0): string[] {
  const ids: string[] = [];
  for (const s of list) {
    const type = TYPE[s.type] ?? 'rect';
    const x = ox + (s.x ?? 0);
    const y = oy + (s.y ?? 0);
    const props: Record<string, unknown> = { x, y };
    if (s.name) props.name = s.name;
    if (s.w !== undefined) props.w = s.w;
    if (s.h !== undefined) props.h = s.h;
    const n = store.create(type, props, parentId);
    if (type === 'text') {
      n.text.autoResize = s.w !== undefined ? 'height' : 'width';
      if (!s.name) n.name = (s.text?.content ?? 'Text').slice(0, 40);
    }
    if (type === 'code' && n.code) {
      n.code = { ...n.code, kind: 'component', storyId: s.storyId, src: s.storyId ? (storySrc[s.storyId] ?? null) : null, title: s.name ?? s.storyId ?? 'Component', hug: s.w === undefined, args: s.args ?? {} };
      if (!s.name) n.name = s.storyId ?? 'Component';
    }
    applySimple(store, n, s);
    if (s.children?.length && n.children) buildNodes(store, s.children, storySrc, n.id, x, y);
    ids.push(n.id);
  }
  return ids;
}

/** Story ids used by component layers anywhere in a list, so their live URLs can be fetched first. */
export function storyIds(list: SimpleNode[], out = new Set<string>()) {
  for (const s of list) {
    if (s.type === 'component' && s.storyId) out.add(s.storyId);
    if (s.children) storyIds(s.children, out);
  }
  return out;
}

/** Moves top-level layers together so their box starts at (x, y). */
export function placeAt(store: Store, ids: string[], x: number, y: number) {
  const b = store.selectionBox(ids);
  if (!b) return;
  for (const id of ids) store.moveBy(id, Math.round(x - b.x), Math.round(y - b.y));
}

/** Where new things go: right of the selection, or right of everything, so nothing lands on top of work. */
export function freeSpot(store: Store, nextToSelection: boolean) {
  const sel = nextToSelection && store.selection.length ? store.selectionBox() : null;
  if (sel) return { x: sel.x + sel.w + 80, y: sel.y };
  const all = store.selectionBox(store.doc.root);
  if (!all) {
    const v = store.view;
    return { x: Math.round(-v.x / v.zoom + 80), y: Math.round(-v.y / v.zoom + 80) };
  }
  return { x: all.x + all.w + 120, y: all.y };
}

const hexOf = (fills: { type: string; color?: string; opacity?: number; visible?: boolean }[] | undefined) => {
  const f = (fills ?? []).find((p) => p.visible !== false && p.type === 'solid');
  if (!f || !f.color) return undefined;
  return f.opacity !== undefined && f.opacity < 1 ? `${f.color}${Math.round(f.opacity * 255).toString(16).padStart(2, '0')}` : f.color;
};

/** An editor layer as Claude reads it: the simple shape, with ids, children relative to the parent. */
export function describe(store: Store, n: EditorNode, depth = 0, budget = { left: 80 }, ox = 0, oy = 0): Record<string, unknown> {
  budget.left--;
  const d: Record<string, unknown> = { id: n.id, type: n.type === 'code' ? 'component' : n.type, name: n.name, x: Math.round(n.x - ox), y: Math.round(n.y - oy), w: Math.round(n.w), h: Math.round(n.h) };
  if (n.type === 'text') d.text = { content: n.text.content, fontFamily: n.text.fontFamily, fontSize: n.text.fontSize, fontWeight: n.text.fontWeight, color: hexOf(n.fills), align: n.text.align, lineHeight: n.text.lineHeight ?? undefined };
  else {
    const fill = hexOf(n.fills);
    if (fill) d.fill = fill;
    if ((n.fills ?? []).some((f: { type: string }) => f.type === 'image')) d.image = true;
  }
  const stroke = hexOf(n.strokes);
  if (stroke) Object.assign(d, { stroke, strokeWidth: n.strokeWidth });
  if (n.radii) d.radius = n.radii;
  else if (n.radius) d.radius = n.radius;
  if (n.opacity !== 1) d.opacity = n.opacity;
  if (n.rotation) d.rotation = n.rotation;
  if (n.layout) d.layout = { mode: n.layout.mode, gap: n.layout.gap, padding: [n.layout.padding.t, n.layout.padding.r, n.layout.padding.b, n.layout.padding.l], align: n.layout.primary, counterAlign: n.layout.counter };
  if (n.sizing && (n.sizing.h !== 'fixed' || n.sizing.v !== 'fixed')) d.sizing = n.sizing;
  if (n.effects?.length) d.effects = n.effects.filter((e: { visible?: boolean }) => e.visible !== false).map((e: { type: string }) => e.type);
  if (n.type === 'code' && n.code) Object.assign(d, { storyId: n.code.storyId, file: n.code.file, args: n.code.args, url: n.code.url, hug: n.code.hug });
  if (n.codeLink) d.codeLink = n.codeLink;
  if (n.children?.length) {
    if (depth < 4 && budget.left > 0) d.children = n.children.map((c) => store.get(c)).filter(Boolean).map((c) => describe(store, c as EditorNode, depth + 1, budget, n.x, n.y));
    else d.childCount = n.children.length;
  }
  return d;
}

export function canvasState(store: Store): CanvasState {
  return {
    selection: store.selected().map((n) => describe(store, n)),
    layers: store.doc.root.map((id) => store.get(id)).filter(Boolean).map((n) => {
      const x = n as EditorNode;
      return { id: x.id, name: x.name, type: x.type === 'code' ? 'component' : x.type, x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h), ...(x.children ? { children: x.children.length } : {}) };
    }),
  };
}

/** One line for the chat chip and the note Claude gets with the next message. */
export function selectionContext(store: Store) {
  const sel = store.selected();
  if (!sel.length) return undefined;
  const kind = (n: EditorNode) => (n.type === 'code' ? (n.code?.kind === 'page' ? 'live page' : 'coded component') : n.type);
  const label = sel.length === 1 ? sel[0].name : `${sel.length} layers`;
  const list = sel
    .slice(0, 6)
    .map((n) => `${kind(n)} "${n.name}" (id ${n.id}, ${Math.round(n.w)}×${Math.round(n.h)}${n.type === 'code' && n.code?.storyId ? `, story ${n.code.storyId}` : ''}${n.codeLink?.storyId ? `, linked to story ${n.codeLink.storyId}` : ''})`)
    .join(', ');
  return { label, text: `The user has selected on the canvas: ${list}${sel.length > 6 ? ` and ${sel.length - 6} more` : ''}. Read it with get_canvas when you need the details.` };
}
