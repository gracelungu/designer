// Pen (P): click for corners, drag for curves, click the first point to close,
// Enter or Escape to finish. Pencil (Shift+P) lives in pencil.js.

import * as G from '../core/geometry.js';
import { frameAt } from '../core/hittest.js';
import { normaliseVector } from './select.js';

export function createVectorFromWorld(store, worldPoints, closed, props = {}) {
  const parent = frameAt(store, worldPoints[0]);
  const inv = G.invert(store.spaceMatrix(parent));
  const toL = (p) => p && G.apply(inv, p);
  const pts = worldPoints.map((p) => ({ ...toL(p), in: toL(p.in), out: toL(p.out) }));
  const n = store.create('vector', { x: 0, y: 0, w: 1, h: 1, points: pts, closed, ...props }, parent);
  normaliseVector(n);
  if (closed && !props.fills) n.fills = [{ type: 'solid', color: '#D9D9D9', opacity: 1, visible: true }];
  return n;
}

export class PenTool {
  constructor(editor) {
    this.editor = editor;
    this.cursor = 'crosshair';
    this.points = [];
    this.dragging = false;
  }
  get store() { return this.editor.store; }

  activate() { this.points = []; this.sync(); }
  deactivate() { this.finish(false); }

  sync(cursor = null, closing = false) {
    this.store.setOverlay({ pen: this.points.length ? { points: this.points, cursor, closing, dragging: this.dragging } : null });
  }

  nearFirst(e) {
    if (this.points.length < 3) return false;
    const s = this.editor.toScreen(this.points[0]);
    return Math.hypot(s.x - e.screen.x, s.y - e.screen.y) < 8;
  }

  constrain(p, e) {
    const last = this.points[this.points.length - 1];
    if (!e.shift || !last) return { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 };
    const ang = Math.atan2(p.y - last.y, p.x - last.x);
    const sa = (Math.round((ang * 180) / Math.PI / 45) * 45 * Math.PI) / 180;
    const len = Math.hypot(p.x - last.x, p.y - last.y);
    return { x: last.x + Math.cos(sa) * len, y: last.y + Math.sin(sa) * len };
  }

  onHover(e, p) {
    this.store.setHover(null);
    if (this.points.length) this.sync(this.constrain(p, e), this.nearFirst(e));
  }

  onDown(e, p) {
    if (this.nearFirst(e)) { this.finish(true); return; }
    const q = this.constrain(p, e);
    this.points.push({ x: q.x, y: q.y, in: null, out: null });
    this.dragging = true;
    this.downAt = e.screen;
    this.sync();
  }

  onMove(e, p) {
    if (!this.dragging) return;
    const pt = this.points[this.points.length - 1];
    if (Math.hypot(e.screen.x - this.downAt.x, e.screen.y - this.downAt.y) < 3) return;
    pt.out = { x: p.x, y: p.y };
    pt.in = e.alt && pt.in ? pt.in : { x: 2 * pt.x - p.x, y: 2 * pt.y - p.y };
    if (this.points.length === 1) pt.in = null;
    this.sync();
  }

  onUp() {
    this.dragging = false;
    this.sync();
  }

  onDoubleClick() {
    // a double click ends an open path (the second click added a duplicate point)
    if (this.points.length > 1) this.points.pop();
    this.finish(false);
  }

  onKey(e) {
    if (e.key === 'Enter' || e.key === 'Escape') {
      const had = this.points.length > 0;
      this.finish(false);
      if (had || e.key === 'Escape') this.editor.setTool('move');
      return true;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.points.length) {
      this.points.pop();
      this.sync();
      return true;
    }
    return false;
  }

  finish(closed) {
    const store = this.store;
    const pts = this.points;
    this.points = [];
    this.dragging = false;
    store.setOverlay({ pen: null });
    if (pts.length < 2) return;
    if (closed && pts[0]) {
      // the closing click can carry a curve handle back to the first point
    }
    let id;
    store.transact(() => {
      const n = createVectorFromWorld(store, pts, closed);
      id = n.id;
    });
    store.select([id]);
    if (closed) this.editor.setTool('move');
  }
}
