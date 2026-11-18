// Frame (F), Section (Shift+S), Rectangle (R), Ellipse (O), Line (L), Arrow (Shift+L),
// Polygon, Star, and placing images (Shift+Cmd+K). Click for a default size, drag to draw;
// Shift keeps proportions (or 45° for lines), Alt draws from the centre.

import * as G from '../core/geometry.js';
import { isLine, isFrameLike } from '../core/model.js';
import { frameAt } from '../core/hittest.js';
import { snapTargets, snapPoint } from '../core/snap.js';
import { setLine } from './select.js';

const DEFAULT = { frame: [100, 100], section: [400, 300], rect: [100, 100], ellipse: [100, 100], polygon: [100, 100], star: [100, 100], line: [100, 0], arrow: [100, 0], image: [100, 100] };

export class ShapeTool {
  constructor(editor, type) {
    this.editor = editor;
    this.type = type;
    this.cursor = 'crosshair';
    this.drag = null;
  }
  get store() { return this.editor.store; }

  onHover(e, p) { this.store.setHover(null); }

  parentFor(p) {
    const store = this.store;
    let parent = frameAt(store, p);
    if (this.type === 'section') {
      while (parent && store.get(parent).type !== 'section') parent = store.get(parent).parent;
    }
    return parent;
  }

  snap(p, e) {
    if (e.mod) return { p, guides: [] };
    const s = snapPoint(p, this.targets || [], 5 / this.store.view.zoom);
    const q = { x: s.snappedX ? s.point.x : Math.round(p.x), y: s.snappedY ? s.point.y : Math.round(p.y) };
    return { p: q, guides: s.guides.filter((g) => (s.snappedX && g.x1 === g.x2 && Math.abs(g.x1 - q.x) < 0.5) || (s.snappedY && g.y1 === g.y2 && Math.abs(g.y1 - q.y) < 0.5)) };
  }

  onDown(e, p) {
    const store = this.store;
    if (this.type === 'image' && !this.editor.pendingImages.length) { this.editor.pickImages(); return; }
    const parent = this.parentFor(p);
    this.targets = snapTargets(store, parent, []);
    const s = this.snap(p, e);
    store.checkpoint();
    this.drag = { start: s.p, parent, node: null, screen: e.screen };
  }

  onMove(e, p) {
    const d = this.drag;
    if (!d) return;
    const store = this.store;
    if (!d.node && Math.hypot(e.screen.x - d.screen.x, e.screen.y - d.screen.y) < 3) return;
    if (!d.node) d.node = this.createNode(d.parent, d.start, 1, 1);
    const s = this.snap(p, e);
    this.applyDrag(d.node, d.start, s.p, e);
    store.overlay.guides = s.guides;
    store.finalize();
    store.emit('doc');
  }

  onUp(e, p) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const store = this.store;
    if (!d.node) {
      let [w, h] = DEFAULT[this.type];
      if (this.type === 'image') {
        const img = this.editor.pendingImages[0];
        const vr = this.editor.viewRect();
        const max = Math.min(vr.w, vr.h) * 0.6;
        w = img.size.w; h = img.size.h;
        if (w > max || h > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      }
      d.node = this.createNode(d.parent, d.start, w, h);
      if (isLine(d.node)) setLine(d.node, store.worldToParent(d.parent, d.start), store.worldToParent(d.parent, { x: d.start.x + w, y: d.start.y }));
    }
    const n = d.node;
    if (this.type === 'frame' || this.type === 'section') this.adoptEnclosed(n);
    store.overlay.guides = [];
    store.selection = [n.id];
    store.commit();
    store.emit('selection');
    if (this.type === 'image') {
      this.editor.pendingImages.shift();
      if (this.editor.pendingImages.length) return;
    }
    this.editor.setTool('move');
  }

  createNode(parent, at, w, h) {
    const store = this.store;
    const type = this.type === 'image' ? 'image' : this.type;
    const lp = store.worldToParent(parent, at);
    const props = { x: lp.x, y: lp.y, w, h };
    if (type === 'image') {
      const img = this.editor.pendingImages[0];
      props.name = img.name || 'Image';
      const n = store.create('image', props, parent);
      n.fills[0].asset = img.id;
      n.aspect = img.size.w / img.size.h;
      return n;
    }
    if (type === 'frame' && parent && !store.get(parent).layout) props.clip = true;
    return store.create(type, props, parent);
  }

  applyDrag(n, a, b, e) {
    const store = this.store;
    if (isLine(n)) {
      if (e.shift) {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const sa = (Math.round((ang * 180) / Math.PI / 45) * 45 * Math.PI) / 180;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        b = { x: a.x + Math.cos(sa) * len, y: a.y + Math.sin(sa) * len };
      }
      const start = e.alt ? { x: 2 * a.x - b.x, y: 2 * a.y - b.y } : a;
      setLine(n, store.worldToParent(n.parent, start), store.worldToParent(n.parent, b));
      return;
    }
    let dx = b.x - a.x, dy = b.y - a.y;
    const ratio = this.type === 'image' && n.aspect ? n.aspect : 1;
    if (e.shift || this.type === 'image') {
      const m = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * (m / ratio);
    }
    let x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy);
    let w = Math.abs(dx), h = Math.abs(dy);
    if (e.alt) { x = a.x - w; y = a.y - h; w *= 2; h *= 2; }
    const lp = store.worldToParent(n.parent, { x, y });
    Object.assign(n, { x: lp.x, y: lp.y, w: Math.max(1, w), h: Math.max(1, h) });
  }

  /** Drawing a frame or section around layers moves them inside it, like Figma. */
  adoptEnclosed(frame) {
    const store = this.store;
    const box = store.worldBox(frame.id);
    if (box.w < 2 || box.h < 2) return;
    const siblings = store.childIds(frame.parent).filter((id) => id !== frame.id);
    for (const id of siblings) {
      const n = store.get(id);
      if (!n.visible || n.locked) continue;
      if (frame.type === 'frame' && isFrameLike(n) && !n.parent && n.type === 'section') continue;
      if (G.boxContains(box, store.worldBox(id))) store.reparent(id, frame.id);
    }
  }
}
