// Resizing and scaling nodes, including their subtrees (constraints, group scaling).

import * as G from './geometry.js';

/**
 * Sets a node's box in its parent space and adapts its children.
 * opts.scale  — scale tool (K): also scales stroke, radius, font size, effects.
 * opts.mode   — 'auto' (constraints for frames, scale for groups) or 'scale'.
 */
export function setBox(store, id, box, opts = {}) {
  const n = store.get(id);
  if (!n) return;
  const old = { x: n.x, y: n.y, w: n.w, h: n.h };
  const sx = old.w ? box.w / old.w : 1;
  const sy = old.h ? box.h / old.h : 1;
  n.x = box.x; n.y = box.y; n.w = box.w; n.h = box.h;

  if (opts.scale) scaleProps(n, Math.sqrt(Math.abs(sx * sy)) || 1);

  if (n.type === 'vector' && n.points) {
    const fx = old.w ? sx : 1, fy = old.h ? sy : 1;
    const map = (p) => p && { x: p.x * fx, y: p.y * fy };
    n.points = n.points.map((p) => ({ x: p.x * fx, y: p.y * fy, in: map(p.in), out: map(p.out) }));
  }

  if (!n.children || !n.children.length) return;
  const mode = opts.scale || n.type === 'group' || opts.mode === 'scale' ? 'scale' : 'constraints';
  for (const cid of n.children) {
    const c = store.get(cid);
    if (!c) continue;
    if (mode === 'scale') {
      setBox(store, cid, {
        x: box.x + (c.x - old.x) * sx,
        y: box.y + (c.y - old.y) * sy,
        w: c.w * Math.abs(sx),
        h: c.h * Math.abs(sy),
      }, { scale: opts.scale, mode: 'scale' });
    } else if (n.layout && !c.absolute) {
      // auto layout positions these on the next layout pass; keep them with the frame
      store.moveBy(cid, box.x - old.x, box.y - old.y);
    } else {
      const h = axis(c.constraints?.h || 'left', c.x, c.w, old.x, old.w, box.x, box.w);
      const v = axis(c.constraints?.v || 'top', c.y, c.h, old.y, old.h, box.y, box.h);
      if (h.size !== c.w || v.size !== c.h) setBox(store, cid, { x: h.pos, y: v.pos, w: h.size, h: v.size });
      else store.moveBy(cid, h.pos - c.x, v.pos - c.y);
    }
  }
}

function axis(rule, pos, size, oPos, oSize, nPos, nSize) {
  switch (rule) {
    case 'right':
    case 'bottom':
      return { pos: nPos + nSize - (oPos + oSize - pos), size };
    case 'leftright':
    case 'topbottom':
    case 'stretch':
      return { pos: nPos + (pos - oPos), size: Math.max(0, size + (nSize - oSize)) };
    case 'center':
      return { pos: nPos + nSize / 2 + (pos + size / 2 - (oPos + oSize / 2)) - size / 2, size };
    case 'scale': {
      const s = oSize ? nSize / oSize : 1;
      return { pos: nPos + (pos - oPos) * s, size: size * s };
    }
    default:
      return { pos: nPos + (pos - oPos), size };
  }
}

function scaleProps(n, s) {
  if (n.strokeWidth) n.strokeWidth = G.round(n.strokeWidth * s);
  if (n.radius) n.radius = G.round(n.radius * s);
  if (n.radii) n.radii = n.radii.map((r) => G.round(r * s));
  if (n.text) {
    n.text.fontSize = G.round(n.text.fontSize * s);
    if (n.text.lineHeight) n.text.lineHeight = G.round(n.text.lineHeight * s);
  }
  for (const e of n.effects || []) {
    if ('x' in e) { e.x = G.round(e.x * s); e.y = G.round(e.y * s); }
    if ('blur' in e) e.blur = G.round(e.blur * s);
    if ('spread' in e) e.spread = G.round(e.spread * s);
  }
  if (n.layout) {
    n.layout.gap = G.round(n.layout.gap * s);
    for (const k of ['t', 'r', 'b', 'l']) n.layout.padding[k] = G.round(n.layout.padding[k] * s);
  }
}

/** Rotates nodes as a rigid set around a world point. */
export function rotateNodes(store, ids, origin, delta, originals) {
  for (const id of ids) {
    const n = store.get(id);
    const o = originals[id];
    if (!n || !o) continue;
    if (n.type === 'group') {
      // groups have no rotation of their own: rotate their children instead
      rotateNodes(store, n.children, origin, delta, originals);
      continue;
    }
    const pm = store.parentMatrix(id);
    const worldC = G.apply(pm, { x: o.x + o.w / 2, y: o.y + o.h / 2 });
    const r = (delta * Math.PI) / 180;
    const dx = worldC.x - origin.x, dy = worldC.y - origin.y;
    const nc = { x: origin.x + dx * Math.cos(r) - dy * Math.sin(r), y: origin.y + dx * Math.sin(r) + dy * Math.cos(r) };
    const local = G.apply(G.invert(pm), nc);
    n.rotation = G.normAngle(o.rotation + delta);
    store.moveBy(id, local.x - o.w / 2 - n.x, local.y - o.h / 2 - n.y);
  }
}

/** Resolves a resize: pointer in world space dragging a handle of a single node. */
export function resizeSingle(store, id, orig, handle, world, { shift, alt, origMatrix }) {
  const inv = G.invert(origMatrix);
  const p = G.apply(inv, world);
  let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
  const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const cx = orig.x + orig.w / 2, cy = orig.y + orig.h / 2;
  if (hx === 1) x2 = p.x;
  if (hx === -1) x1 = p.x;
  if (hy === 1) y2 = p.y;
  if (hy === -1) y1 = p.y;
  if (alt) {
    if (hx === 1) x1 = cx - (x2 - cx);
    if (hx === -1) x2 = cx + (cx - x1);
    if (hy === 1) y1 = cy - (y2 - cy);
    if (hy === -1) y2 = cy + (cy - y1);
  }
  let w = x2 - x1, h = y2 - y1;
  if (shift && orig.w && orig.h) {
    const ratio = orig.w / orig.h;
    if (hx && hy) {
      if (Math.abs(w) / ratio > Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / ratio;
      else w = Math.sign(w || 1) * Math.abs(h) * ratio;
    } else if (hx) h = Math.abs(w) / ratio;
    else w = Math.abs(h) * ratio;
    if (hx === -1) x1 = x2 - w; else if (hx === 1) x2 = x1 + w;
    if (hy === -1) y1 = y2 - h; else if (hy === 1) y2 = y1 + h;
    if (!hy) { y1 = cy - h / 2; y2 = cy + h / 2; }
    if (!hx) { x1 = cx - w / 2; x2 = cx + w / 2; }
    if (alt) {
      if (hx) { x1 = cx - Math.abs(w) / 2; x2 = cx + Math.abs(w) / 2; }
      if (hy) { y1 = cy - Math.abs(h) / 2; y2 = cy + Math.abs(h) / 2; }
    }
  }
  const box = {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.max(Math.abs(x2 - x1), 0.01), h: Math.max(Math.abs(y2 - y1), 0.01),
  };
  const flipX = x2 < x1, flipY = y2 < y1;
  // Keep the opposite corner fixed on screen even though rotation is about the centre.
  const anchor = {
    x: alt ? cx : hx === 1 ? orig.x : hx === -1 ? orig.x + orig.w : cx,
    y: alt ? cy : hy === 1 ? orig.y : hy === -1 ? orig.y + orig.h : cy,
  };
  const worldAnchor = G.apply(origMatrix, anchor);
  const n = store.get(id);
  const pm = store.parentMatrix(id);
  const trial = G.multiply(pm, G.rotateAbout(n.rotation, box.x + box.w / 2, box.y + box.h / 2, n.flipX, n.flipY));
  const now = G.apply(trial, anchor);
  const t = G.applyVec(G.invert(pm), { x: worldAnchor.x - now.x, y: worldAnchor.y - now.y });
  box.x += t.x; box.y += t.y;
  return { box, flipX, flipY };
}
