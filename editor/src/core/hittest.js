// Hit testing against real shape geometry (fills and strokes), using Path2D.

import * as G from './geometry.js';
import { pathFor } from './paths.js';

let ctx = null;
function context() {
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

const BOX_TYPES = new Set(['frame', 'section', 'text', 'image', 'code']);

export function hitNode(store, n, world, tol) {
  const m = store.matrix(n.id);
  const p = G.apply(G.invert(m), world);
  const t = tol / (G.scaleOf(m) || 1);
  if (BOX_TYPES.has(n.type)) return G.pointInBox(p, n);
  if (n.type === 'line' || n.type === 'arrow') {
    return G.distToSegment(p, { x: n.x, y: n.y }, { x: n.x + n.w, y: n.y }) <= Math.max(t, (n.strokeWidth || 1) / 2 + 1);
  }
  const c = context();
  const visFills = (n.fills || []).some((f) => f.visible !== false);
  const visStrokes = (n.strokes || []).some((s) => s.visible !== false);
  const isOpen = n.type === 'vector' && !n.closed;
  if (!c) return G.pointInBox(p, n, t);
  const path = new Path2D(pathFor(n));
  if (visFills && !isOpen && c.isPointInPath(path, p.x, p.y)) return true;
  if (visFills && isOpen && c.isPointInPath(path, p.x, p.y)) return true;
  c.lineWidth = Math.max(t * 2, visStrokes ? n.strokeWidth || 1 : 0);
  if (c.isPointInStroke(path, p.x, p.y)) return true;
  // tiny or empty shapes: fall back to the box so they stay clickable
  if (!visFills && !visStrokes) return G.pointInBox(p, n, t);
  return false;
}

/** Returns the hit chain [topmost ancestor, ..., deepest node] or null. */
export function hitTest(store, world, tol = 3, { includeLocked = false } = {}) {
  const walk = (ids, chain) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = store.get(ids[i]);
      if (!n || !n.visible || (n.locked && !includeLocked)) continue;
      if (n.children) {
        let inside = false;
        if (n.type !== 'group') {
          const p = G.apply(G.invert(store.matrix(n.id)), world);
          inside = G.pointInBox(p, n);
          if (n.clip && !inside) continue;
        }
        const r = walk(n.children, chain.concat(n.id));
        if (r) return r;
        if (inside) return chain.concat(n.id);
      } else if (hitNode(store, n, world, tol)) {
        return chain.concat(n.id);
      }
    }
    return null;
  };
  return walk(store.doc.root, []);
}

/** Nodes in a parent whose world bounds touch a world rect. */
export function nodesInRect(store, rect, parentId, { contain = false } = {}) {
  return store.childIds(parentId).filter((id) => {
    const n = store.get(id);
    if (!n.visible || n.locked) return false;
    const b = store.worldBox(id);
    return contain ? G.boxContains(rect, b) : G.boxesIntersect(rect, b);
  });
}

/** Deepest frame or section (not in `exclude`) under a world point, used as a drop target. */
export function frameAt(store, world, exclude = []) {
  const ex = new Set(exclude);
  const walk = (ids) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const n = store.get(id);
      if (!n || ex.has(id) || !n.visible || n.locked || !n.children || n.type === 'group') {
        if (n && n.type === 'group' && !ex.has(id) && n.visible) {
          const r = walk(n.children);
          if (r) return r;
        }
        continue;
      }
      const p = G.apply(G.invert(store.matrix(id)), world);
      if (!G.pointInBox(p, n)) continue;
      return walk(n.children) || id;
    }
    return null;
  };
  return walk(store.doc.root);
}
