// Auto layout: a flexbox-like engine for frames with layout.mode set.
//
// frame.layout = { mode: 'horizontal' | 'vertical', gap, padding: {t,r,b,l},
//                  primary: 'start'|'center'|'end'|'space-between', counter: 'start'|'center'|'end' }
// node.sizing  = { h: 'fixed'|'hug'|'fill', v: 'fixed'|'hug'|'fill' }

import { setBox } from './transform.js';

export function defaultLayout(mode = 'vertical') {
  return { mode, gap: 10, padding: { t: 10, r: 10, b: 10, l: 10 }, primary: 'start', counter: 'start' };
}

export function layoutTree(store) {
  for (const id of store.doc.root.slice()) layoutNode(store, id);
}

export function layoutNode(store, id) {
  const n = store.get(id);
  if (!n || !n.children) return;
  for (const c of n.children) layoutNode(store, c);
  if (!n.layout || n.type === 'group') return;

  const L = n.layout;
  const horiz = L.mode === 'horizontal';
  const M = horiz ? 'w' : 'h', C = horiz ? 'h' : 'w';
  const MP = horiz ? 'x' : 'y', CP = horiz ? 'y' : 'x';
  const mainAxis = horiz ? 'h' : 'v', crossAxis = horiz ? 'v' : 'h';
  const pad = L.padding;
  const padMainStart = horiz ? pad.l : pad.t;
  const padMain = horiz ? pad.l + pad.r : pad.t + pad.b;
  const padCrossStart = horiz ? pad.t : pad.l;
  const padCross = horiz ? pad.t + pad.b : pad.l + pad.r;

  const kids = n.children.map((c) => store.get(c)).filter((c) => c && c.visible && !c.absolute && !c._dragging);
  const hugMain = n.sizing?.[mainAxis] === 'hug';
  const hugCross = n.sizing?.[crossAxis] === 'hug';
  const size = (c) => store.parentSpaceBox(c);
  const isFill = (c, ax) => c.sizing?.[ax] === 'fill' && !c.rotation;

  const fillMain = hugMain ? [] : kids.filter((c) => isFill(c, mainAxis));
  const fixedKids = kids.filter((c) => !fillMain.includes(c));
  const fixedSum = fixedKids.reduce((s, c) => s + size(c)[M], 0);
  const spaceBetween = L.primary === 'space-between';
  const gapTotal = kids.length > 1 && !spaceBetween ? L.gap * (kids.length - 1) : 0;

  if (hugMain) n[M] = Math.max(0, padMain + fixedSum + gapTotal);
  if (fillMain.length) {
    const each = Math.max(1, (n[M] - padMain - fixedSum - gapTotal) / fillMain.length);
    for (const c of fillMain) {
      if (Math.abs(c[M] - each) > 0.001) {
        setBox(store, c.id, { x: c.x, y: c.y, w: M === 'w' ? each : c.w, h: M === 'h' ? each : c.h });
        if (c.type === 'text' && c.text.autoResize === 'width') c.text.autoResize = 'height';
        layoutNode(store, c.id);
      }
    }
  }

  const fillCross = hugCross ? [] : kids.filter((c) => isFill(c, crossAxis));
  if (hugCross) {
    const max = kids.reduce((m, c) => Math.max(m, size(c)[C]), 0);
    n[C] = Math.max(0, padCross + max);
  }
  const availCross = n[C] - padCross;
  for (const c of fillCross) {
    if (Math.abs(c[C] - availCross) > 0.001) {
      setBox(store, c.id, { x: c.x, y: c.y, w: C === 'w' ? Math.max(1, availCross) : c.w, h: C === 'h' ? Math.max(1, availCross) : c.h });
      layoutNode(store, c.id);
    }
  }

  const sizes = kids.map((c) => size(c));
  const used = sizes.reduce((s, b) => s + b[M], 0);
  const avail = n[M] - padMain;
  let gap = L.gap;
  let offset = 0;
  if (spaceBetween) {
    gap = kids.length > 1 ? Math.max(0, (avail - used) / (kids.length - 1)) : 0;
    if (kids.length === 1) offset = 0;
  } else if (L.primary === 'center') offset = (avail - used - gapTotal) / 2;
  else if (L.primary === 'end') offset = avail - used - gapTotal;

  let cursor = n[MP] + padMainStart + offset;
  kids.forEach((c, i) => {
    const b = sizes[i];
    let cross = n[CP] + padCrossStart;
    if (L.counter === 'center') cross += (availCross - b[C]) / 2;
    else if (L.counter === 'end') cross += availCross - b[C];
    const dMain = cursor - b[MP];
    const dCross = cross - b[CP];
    store.moveBy(c.id, horiz ? dMain : dCross, horiz ? dCross : dMain);
    cursor += b[M] + gap;
  });
}

/** Index a dragged child should take inside an auto layout frame for a pointer position (frame space). */
export function insertionIndex(store, frame, p, excludeIds = []) {
  const horiz = frame.layout.mode === 'horizontal';
  const kids = frame.children.filter((c) => !excludeIds.includes(c)).map((c) => store.get(c)).filter((c) => c.visible && !c.absolute);
  let idx = kids.length;
  for (let i = 0; i < kids.length; i++) {
    const b = store.parentSpaceBox(kids[i]);
    const mid = horiz ? b.x + b.w / 2 : b.y + b.h / 2;
    if ((horiz ? p.x : p.y) < mid) { idx = i; break; }
  }
  // convert to an index in the full child list
  const before = kids[idx];
  const full = frame.children.filter((c) => !excludeIds.includes(c));
  return before ? full.indexOf(before.id) : full.length;
}

/** Guesses direction and gap from the current arrangement, like Shift+A does. */
export function guessLayout(boxes) {
  if (boxes.length < 2) return { mode: 'vertical', gap: 10 };
  const xs = boxes.map((b) => b.x), ys = boxes.map((b) => b.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  const mode = spreadX > spreadY ? 'horizontal' : 'vertical';
  const sorted = boxes.slice().sort((a, b) => (mode === 'horizontal' ? a.x - b.x : a.y - b.y));
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    gaps += mode === 'horizontal' ? sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) : sorted[i].y - (sorted[i - 1].y + sorted[i - 1].h);
  }
  return { mode, gap: Math.max(0, Math.round(gaps / (sorted.length - 1))) };
}
