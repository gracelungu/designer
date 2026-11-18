// Screen-space overlay: hover and selection outlines, handles, labels, guides, marquee.

import * as G from '../core/geometry.js';
import { pathFor, vectorPath } from '../core/paths.js';
import { isLine, isFrameLike } from '../core/model.js';
import { escapeHTML } from './text.js';

export const SEL = '#0C8CE9';
export const GUIDE = '#F43F5E';

let mctx = null;
function textWidth(s, font = '500 11px Inter, system-ui, sans-serif') {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = font;
  return mctx.measureText(s).width;
}

const fmt = (v) => {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, '');
};

/** Labels above top-level frames and inside sections (screen coords). */
export function frameLabels(editor) {
  const store = editor.store;
  const out = [];
  const add = (id) => {
    const n = store.get(id);
    if (!n || !n.visible || !isFrameLike(n)) return;
    const c = store.worldCorners(id).map((p) => editor.toScreen(p));
    const tl = c[0];
    const width = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    const tw = Math.min(textWidth(n.name), Math.max(20, width - 4));
    if (n.type === 'section') out.push({ id, kind: 'section', x: tl.x + 8, y: tl.y + 8, w: tw + 16, h: 22, text: n.name });
    else out.push({ id, kind: 'frame', x: tl.x, y: tl.y - 18, w: tw + 2, h: 16, text: n.name, maxW: width });
    if (n.type === 'section') for (const c2 of n.children) add(c2);
  };
  for (const id of store.doc.root) add(id);
  return out;
}

/** Screen geometry for the current selection's box and handles. */
export function selectionGeometry(editor) {
  const store = editor.store;
  const sel = store.selection.filter((id) => store.get(id));
  if (!sel.length || store.editingText) return null;
  if (sel.length === 1) {
    const n = store.get(sel[0]);
    if (isLine(n)) {
      const m = store.matrix(n.id);
      const a = editor.toScreen(G.apply(m, { x: n.x, y: n.y }));
      const b = editor.toScreen(G.apply(m, { x: n.x + n.w, y: n.y }));
      return { kind: 'line', id: n.id, a, b, corners: [a, b, b, a] };
    }
    const corners = store.worldCorners(n.id).map((p) => editor.toScreen(p));
    return { kind: 'single', id: n.id, corners };
  }
  const b = store.selectionBox(sel);
  const tl = editor.toScreen({ x: b.x, y: b.y });
  const br = editor.toScreen({ x: b.x + b.w, y: b.y + b.h });
  return { kind: 'multi', corners: [tl, { x: br.x, y: tl.y }, br, { x: tl.x, y: br.y }] };
}

const HANDLE_NAMES = ['nw', 'ne', 'se', 'sw'];
const EDGE_NAMES = ['n', 'e', 's', 'w'];

/** What is under a screen point: a resize handle, an edge, a rotation zone or a line endpoint. */
export function handleAt(editor, s) {
  const geo = selectionGeometry(editor);
  if (!geo) return null;
  if (geo.kind === 'line') {
    if (Math.hypot(s.x - geo.a.x, s.y - geo.a.y) < 8) return { type: 'endpoint', which: 'start' };
    if (Math.hypot(s.x - geo.b.x, s.y - geo.b.y) < 8) return { type: 'endpoint', which: 'end' };
    return null;
  }
  const c = geo.corners;
  const small = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) < 12 || Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) < 12;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(s.x - c[i].x, s.y - c[i].y) <= 6) return { type: 'resize', handle: HANDLE_NAMES[i], angle: angleFor(c, HANDLE_NAMES[i]) };
  }
  if (!small) {
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      if (G.distToSegment(s, a, b) <= 4) return { type: 'resize', handle: EDGE_NAMES[i], angle: angleFor(c, EDGE_NAMES[i]) };
    }
  }
  if (!pointInPoly(s, c)) {
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(s.x - c[i].x, s.y - c[i].y);
      if (d > 5 && d < 22) return { type: 'rotate', handle: HANDLE_NAMES[i] };
    }
  }
  return null;
}

function angleFor(c, h) {
  const cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
  const idx = { nw: 0, ne: 1, se: 2, sw: 3 };
  let p;
  if (h in idx) p = c[idx[h]];
  else {
    const e = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] }[h];
    p = { x: (c[e[0]].x + c[e[1]].x) / 2, y: (c[e[0]].y + c[e[1]].y) / 2 };
  }
  return (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
}

export function resizeCursor(angle) {
  const a = ((angle % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 15a7 7 0 0 1 11-8" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M6 15a7 7 0 0 1 11-8" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round"/><path d="M14 4.5l4 2.5-2.6 3.6" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`;
export const rotateCursor = () => ROTATE_CURSOR;

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function outline(editor, n, color = SEL, width = 1) {
  const store = editor.store;
  const m = G.multiply(editor.viewMatrix(), store.matrix(n.id));
  let d;
  if (n.type === 'group' || n.type === 'text' || isFrameLike(n) || n.type === 'image' || n.type === 'code') d = `M${n.x} ${n.y}h${n.w}v${n.h}h${-n.w}Z`;
  else d = pathFor(n);
  return `<path d="${d}" transform="${G.toSVG(m)}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
}

const poly = (pts) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

function badge(x, y, text, color = SEL) {
  const w = textWidth(text, '500 11px Inter, system-ui, sans-serif') + 10;
  return `<g><rect x="${x - w / 2}" y="${y}" width="${w}" height="18" rx="3" fill="${color}"/><text x="${x}" y="${y + 12.5}" text-anchor="middle" fill="#fff" font-size="11" font-weight="500" font-family="Inter, system-ui, sans-serif">${escapeHTML(text)}</text></g>`;
}

export function renderOverlay(editor) {
  const store = editor.store;
  const o = store.overlay || {};
  let s = '';

  // frame and section labels
  for (const l of frameLabels(editor)) {
    const active = store.selection.includes(l.id) || store.hover === l.id;
    if (l.kind === 'section') {
      const n = store.get(l.id);
      s += `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="5" fill="${active ? SEL : '#E4E4E7'}"/>`;
      s += `<text x="${l.x + 8}" y="${l.y + 15}" font-size="11" font-weight="500" font-family="Inter, system-ui, sans-serif" fill="${active ? '#fff' : '#3F3F46'}">${escapeHTML(clip(n.name, l.w - 16))}</text>`;
    } else {
      s += `<text x="${l.x}" y="${l.y + 12}" font-size="11" font-weight="500" font-family="Inter, system-ui, sans-serif" fill="${active ? SEL : '#6B6B6B'}">${escapeHTML(clip(l.text, l.maxW))}</text>`;
    }
  }

  // drop target while dragging into a frame
  if (o.dropTarget && store.get(o.dropTarget)) s += outline(editor, store.get(o.dropTarget), SEL, 2);

  // hover
  if (store.hover && !store.selection.includes(store.hover) && store.get(store.hover) && !o.marquee) {
    s += outline(editor, store.get(store.hover), SEL, 2);
  }

  // selection
  const geo = selectionGeometry(editor);
  if (geo && !o.hideSelection) {
    for (const id of store.selection) {
      const n = store.get(id);
      if (n && geo.kind === 'multi') s += outline(editor, n, SEL, 1);
    }
    if (geo.kind === 'line') {
      s += `<line x1="${geo.a.x}" y1="${geo.a.y}" x2="${geo.b.x}" y2="${geo.b.y}" stroke="${SEL}" stroke-width="1"/>`;
      for (const p of [geo.a, geo.b]) s += `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#fff" stroke="${SEL}" stroke-width="1.5"/>`;
      const n = store.get(geo.id);
      s += badge((geo.a.x + geo.b.x) / 2, Math.max(geo.a.y, geo.b.y) + 10, fmt(n.w));
    } else {
      const c = geo.corners;
      s += `<polygon points="${poly(c)}" fill="none" stroke="${SEL}" stroke-width="1"/>`;
      const n = geo.kind === 'single' ? store.get(geo.id) : null;
      if (!(n && n.type === 'vector' && o.editingPath)) {
        const ang = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x);
        for (const p of c) {
          s += `<rect x="-4" y="-4" width="8" height="8" fill="#fff" stroke="${SEL}" stroke-width="1" transform="translate(${p.x} ${p.y}) rotate(${(ang * 180) / Math.PI})"/>`;
        }
      }
      // size badge
      const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
      const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const by = Math.max(...ys) + 8;
      let label;
      if (n) {
        const sz = (axis, v) => (n.sizing?.[axis] === 'hug' ? 'Hug' : n.sizing?.[axis] === 'fill' && store.parent(n.id)?.layout ? 'Fill' : fmt(v));
        label = `${sz('h', n.w)} × ${sz('v', n.h)}`;
      } else {
        const b = store.selectionBox();
        label = `${fmt(b.w)} × ${fmt(b.h)}`;
      }
      s += badge(bx, by, label);
    }
  }

  // auto layout insertion marker
  if (o.insert) {
    const a = editor.toScreen({ x: o.insert.x1, y: o.insert.y1 });
    const b = editor.toScreen({ x: o.insert.x2, y: o.insert.y2 });
    s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${SEL}" stroke-width="2.5" stroke-linecap="round"/>`;
  }

  // smart guides
  for (const g of o.guides || []) {
    const a = editor.toScreen({ x: g.x1, y: g.y1 });
    const b = editor.toScreen({ x: g.x2, y: g.y2 });
    s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${GUIDE}" stroke-width="1"/>`;
  }

  // measurements while holding Alt
  if (editor.keys.alt && store.selection.length && !o.dragging && editor.pointer.inside) s += measurements(editor);

  // marquee
  if (o.marquee) {
    const m = o.marquee;
    const a = editor.toScreen({ x: m.x, y: m.y });
    const b = editor.toScreen({ x: m.x + m.w, y: m.y + m.h });
    s += `<rect x="${a.x}" y="${a.y}" width="${b.x - a.x}" height="${b.y - a.y}" fill="rgba(12,140,233,0.08)" stroke="${SEL}" stroke-width="1"/>`;
  }

  // pen preview
  if (o.pen && o.pen.points.length) {
    const pts = o.pen.points.map((p) => ({
      x: editor.toScreen(p).x, y: editor.toScreen(p).y,
      in: p.in && editor.toScreen(p.in), out: p.out && editor.toScreen(p.out),
    }));
    s += `<path d="${vectorPath(pts, false)}" fill="none" stroke="${SEL}" stroke-width="1.5"/>`;
    if (o.pen.cursor && !o.pen.dragging) {
      const last = pts[pts.length - 1];
      const cur = editor.toScreen(o.pen.cursor);
      const c1 = last.out || last;
      s += `<path d="M${last.x} ${last.y}Q${c1.x} ${c1.y} ${cur.x} ${cur.y}" fill="none" stroke="${SEL}" stroke-width="1" stroke-dasharray="4 3"/>`;
    }
    pts.forEach((p, i) => {
      for (const h of [p.in, p.out]) {
        if (!h) continue;
        s += `<line x1="${p.x}" y1="${p.y}" x2="${h.x}" y2="${h.y}" stroke="${SEL}" stroke-width="1"/><circle cx="${h.x}" cy="${h.y}" r="3" fill="#fff" stroke="${SEL}"/>`;
      }
      const closing = i === 0 && o.pen.closing;
      s += `<circle cx="${p.x}" cy="${p.y}" r="${closing ? 5.5 : 4}" fill="${i === pts.length - 1 || closing ? SEL : '#fff'}" stroke="${SEL}" stroke-width="1.5"/>`;
    });
  }

  // vector point editing (double-click a vector)
  if (o.editingPath && store.get(o.editingPath)) {
    const n = store.get(o.editingPath);
    const m = store.matrix(n.id);
    const toS = (p) => editor.toScreen(G.apply(m, { x: p.x + n.x, y: p.y + n.y }));
    n.points.forEach((p, i) => {
      const sp = toS(p);
      for (const h of [p.in, p.out]) {
        if (!h) continue;
        const sh = toS(h);
        s += `<line x1="${sp.x}" y1="${sp.y}" x2="${sh.x}" y2="${sh.y}" stroke="${SEL}" stroke-width="1"/><circle cx="${sh.x}" cy="${sh.y}" r="3" fill="#fff" stroke="${SEL}"/>`;
      }
      const on = o.pathPoint === i;
      s += `<circle cx="${sp.x}" cy="${sp.y}" r="4" fill="${on ? SEL : '#fff'}" stroke="${SEL}" stroke-width="1.5"/>`;
    });
  }

  if (o.pencil && o.pencil.length > 1) {
    const pts = o.pencil.map((p) => editor.toScreen(p));
    s += `<polyline points="${poly(pts)}" fill="none" stroke="#111" stroke-width="${Math.max(1, (o.pencilWidth || 2) * store.view.zoom)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return s;
}

function clip(text, maxW) {
  if (!maxW || textWidth(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + '…') > maxW) t = t.slice(0, -1);
  return t + '…';
}

function measurements(editor) {
  const store = editor.store;
  const S = store.selectionBox();
  if (!S) return '';
  let targetId = store.hover && !store.selection.includes(store.hover) ? store.hover : null;
  if (!targetId) {
    const p = store.parent(store.selection[0]);
    targetId = p ? p.id : null;
  }
  if (!targetId) return '';
  const T = store.worldBox(targetId);
  const lines = [];
  const contains = G.boxContains(T, S);
  const midY = (Math.max(S.y, T.y) + Math.min(S.y + S.h, T.y + T.h)) / 2;
  const midX = (Math.max(S.x, T.x) + Math.min(S.x + S.w, T.x + T.w)) / 2;
  const cy = S.y + S.h / 2, cx = S.x + S.w / 2;
  if (contains) {
    lines.push({ x1: T.x, y1: cy, x2: S.x, y2: cy });
    lines.push({ x1: S.x + S.w, y1: cy, x2: T.x + T.w, y2: cy });
    lines.push({ x1: cx, y1: T.y, x2: cx, y2: S.y });
    lines.push({ x1: cx, y1: S.y + S.h, x2: cx, y2: T.y + T.h });
  } else {
    const yRef = S.y + S.h < T.y || S.y > T.y + T.h ? cy : midY;
    const xRef = S.x + S.w < T.x || S.x > T.x + T.w ? cx : midX;
    if (S.x + S.w <= T.x) lines.push({ x1: S.x + S.w, y1: yRef, x2: T.x, y2: yRef });
    if (T.x + T.w <= S.x) lines.push({ x1: T.x + T.w, y1: yRef, x2: S.x, y2: yRef });
    if (S.y + S.h <= T.y) lines.push({ x1: xRef, y1: S.y + S.h, x2: xRef, y2: T.y });
    if (T.y + T.h <= S.y) lines.push({ x1: xRef, y1: T.y + T.h, x2: xRef, y2: S.y });
  }
  let s = outline(editor, store.get(targetId), GUIDE, 1);
  for (const l of lines) {
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    if (len < 0.01) continue;
    const a = editor.toScreen({ x: l.x1, y: l.y1 });
    const b = editor.toScreen({ x: l.x2, y: l.y2 });
    s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${GUIDE}" stroke-width="1"/>`;
    s += badge((a.x + b.x) / 2, (a.y + b.y) / 2 - 9, fmt(len), GUIDE);
  }
  return s;
}
