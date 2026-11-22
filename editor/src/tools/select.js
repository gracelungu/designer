// Move (V) and Scale (K) tools: click and marquee selection, moving with smart guides,
// resizing, rotating, line endpoints, reparenting into frames, auto layout reordering.

import * as G from '../core/geometry.js';
import { isFrameLike, isLine } from '../core/model.js';
import { hitTest, nodesInRect, frameAt } from '../core/hittest.js';
import { snapTargets, snapBox, snapPoint } from '../core/snap.js';
import { setBox, resizeSingle, rotateNodes } from '../core/transform.js';
import { insertionIndex, wrappedInsertion } from '../core/layout.js';
import { handleAt, frameLabels, resizeCursor, rotateCursor } from '../render/overlay.js';

const DRAG_THRESHOLD = 3;

/** Figma's click target rules: children of top-level frames are picked directly,
 *  groups need a double click, and Cmd/Ctrl picks the deepest layer. */
export function pickTarget(store, chain, deep) {
  if (!chain || !chain.length) return null;
  if (deep) return chain[chain.length - 1];
  for (const sid of store.selection) {
    const s = store.get(sid);
    if (!s) continue;
    const idx = chain.indexOf(s.parent);
    if (s.parent && idx >= 0 && chain[idx + 1]) return chain[idx + 1];
    if (chain.includes(sid) && chain.indexOf(sid) > 0) {
      // clicking inside something already selected keeps that level
      return sid;
    }
  }
  let i = 0;
  while (i < chain.length - 1 && store.get(chain[i]).type === 'section') i++;
  const top = store.get(chain[i]);
  if (top.type === 'frame' && chain.length > i + 1) return chain[i + 1];
  if (top.type === 'section' && chain.length === i + 1) {
    // empty area of a section with children is like empty canvas
    return top.children.length ? null : top.id;
  }
  if (top.type === 'frame' && chain.length === i + 1 && top.children.length && (i === 0 || store.get(chain[i - 1]).type === 'section')) {
    return null; // empty area of a top-level frame: start a marquee instead
  }
  return chain[i];
}

const effectiveContainer = (store, id) => {
  let p = store.parent(id);
  while (p && p.type === 'group') p = store.parent(p.id);
  return p ? p.id : null;
};

export class SelectTool {
  constructor(editor, { scaleMode = false } = {}) {
    this.editor = editor;
    this.scaleMode = scaleMode;
    this.cursor = 'default';
    this.drag = null;
  }
  get store() { return this.editor.store; }

  deactivate() { this.exitPathEdit(); }

  cursorAt() {
    if (this.drag) return this.drag.cursor || null;
    const s = this.editor.toScreen(this.editor.pointer.world);
    const h = handleAt(this.editor, s);
    if (!h) return this.scaleMode ? 'default' : null;
    if (h.type === 'rotate') return rotateCursor();
    if (h.type === 'endpoint') return 'crosshair';
    return resizeCursor(h.angle);
  }

  tol() { return 4 / this.store.view.zoom; }

  onHover(e, p) {
    const store = this.store;
    if (store.overlay.editingPath) return;
    const label = this.labelAt(e.screen);
    if (label) { store.setHover(label.id); return; }
    const chain = hitTest(store, p, this.tol());
    store.setHover(pickTarget(store, chain, e.mod) || null);
  }

  labelAt(s) {
    return frameLabels(this.editor).find((l) => s.x >= l.x && s.x <= l.x + l.w && s.y >= l.y && s.y <= l.y + l.h);
  }

  onDown(e, p) {
    const store = this.store;
    const ed = this.editor;
    if (ed.textEditor.active) ed.textEditor.commit();
    if (store.overlay.editingPath) {
      if (this.downPathEdit(e, p)) return;
      this.exitPathEdit();
    }
    this.start = { p, screen: e.screen, e };

    const h = handleAt(ed, e.screen);
    if (h && !e.mod) {
      if (h.type === 'rotate') return this.beginRotate(p, e);
      if (h.type === 'endpoint') return this.beginEndpoint(h.which, p);
      return this.beginResize(h.handle, p, e);
    }

    const label = this.labelAt(e.screen);
    let target = label ? label.id : null;
    let chain = null;
    if (!target) {
      chain = hitTest(store, p, this.tol());
      target = pickTarget(store, chain, e.mod);
    }

    if (!target && store.selection.length > 1) {
      const b = store.selectionBox();
      if (b && G.pointInBox(p, b)) {
        this.drag = { kind: 'pending-move', toggleOnClick: null };
        return;
      }
    }

    if (target) {
      if (e.shift) {
        if (store.selection.includes(target)) {
          this.drag = { kind: 'pending-move', toggleOnClick: target };
          return;
        }
        store.select([target], { add: true });
      } else if (!store.selection.includes(target)) {
        store.select([target]);
      }
      this.drag = { kind: 'pending-move', toggleOnClick: null, clickTarget: target };
      return;
    }

    // marquee
    let scope = null;
    if (chain && chain.length) {
      const last = store.get(chain[chain.length - 1]);
      if (isFrameLike(last)) scope = last.id;
    }
    this.drag = { kind: 'marquee', scope, base: e.shift ? store.selection.slice() : [] };
    if (!e.shift) store.select([]);
  }

  onMove(e, p) {
    const d = this.drag;
    if (!d) return;
    const store = this.store;
    const ds = Math.hypot(e.screen.x - this.start.screen.x, e.screen.y - this.start.screen.y);
    if (d.kind === 'pending-move') {
      if (ds < DRAG_THRESHOLD) return;
      this.beginMove(e);
    }
    if (d.kind === 'marquee') return this.moveMarquee(e, p);
    if (this.drag.kind === 'move') return this.doMove(e, p);
    if (d.kind === 'resize') return this.doResize(e, p);
    if (d.kind === 'rotate') return this.doRotate(e, p);
    if (d.kind === 'endpoint') return this.doEndpoint(e, p);
    if (d.kind === 'path-point') return this.doPathPoint(e, p);
    store.emit('overlay');
  }

  onUp(e, p) {
    const d = this.drag;
    this.drag = null;
    const store = this.store;
    if (!d) return;
    if (d.kind === 'pending-move') {
      if (d.toggleOnClick) store.select([d.toggleOnClick], { toggle: true });
      return;
    }
    if (d.kind === 'marquee') {
      store.setOverlay({ marquee: null });
      return;
    }
    if (d.kind === 'move') this.endMove(d);
    store.overlay = { ...store.overlay, guides: [], dropTarget: null, insert: null, dragging: false, hideSelection: false, angle: null };
    store.commit();
  }

  onDoubleClick(e, p) {
    const store = this.store;
    const chain = hitTest(store, p, this.tol());
    if (!chain) return;
    const sel = store.selected();
    if (sel.length === 1) {
      const n = sel[0];
      if (n.type === 'text' && chain.includes(n.id)) { this.editor.textEditor.start(n.id); return; }
      if (n.type === 'vector' && chain.includes(n.id)) { this.enterPathEdit(n.id); return; }
      const idx = chain.indexOf(n.id);
      if (idx >= 0 && chain[idx + 1]) {
        const next = store.get(chain[idx + 1]);
        store.select([next.id]);
        return;
      }
    }
    const target = pickTarget(store, chain, false);
    const t = store.get(target);
    if (t && t.type === 'text') { store.select([t.id]); this.editor.textEditor.start(t.id); }
    else if (t && t.type === 'vector') { store.select([t.id]); this.enterPathEdit(t.id); }
    else if (t && t.children && chain.indexOf(t.id) < chain.length - 1) store.select([chain[chain.indexOf(t.id) + 1]]);
  }

  // ---------- marquee ----------
  moveMarquee(e, p) {
    const store = this.store;
    const a = this.start.p;
    const rect = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
    let ids = [];
    const collect = (parentId) => {
      for (const id of nodesInRect(store, rect, parentId)) {
        const n = store.get(id);
        if (isFrameLike(n) && n.children.length && !G.boxContains(rect, store.worldBox(id))) {
          if (!parentId || store.get(parentId).type === 'section') collect(id);
        } else ids.push(id);
      }
    };
    collect(this.drag.scope);
    ids = [...new Set([...this.drag.base, ...ids])];
    store.overlay.marquee = rect;
    store.select(ids);
    store.emit('overlay');
  }

  // ---------- move ----------
  beginMove(e) {
    const store = this.store;
    let ids = store.selection.filter((id) => !store.isLocked(id));
    if (!ids.length) { this.drag = null; return; }
    store.checkpoint();
    if (e.alt) {
      // Alt-drag duplicates and moves the copies
      const order = store.allIds();
      const copies = [];
      for (const id of ids.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
        const n = store.get(id);
        const [nid] = store.insertClones(store.cloneSubtree(id), n.parent, store.indexInParent(id) + 1);
        copies.push(nid);
      }
      store.selection = copies;
      ids = copies;
      store.emit('selection');
    }
    const orig = {};
    for (const id of ids) { const n = store.get(id); orig[id] = { x: n.x, y: n.y }; }
    const layoutIds = ids.filter((id) => { const p = store.parent(id); return p && p.layout && !store.get(id).absolute; });
    for (const id of layoutIds) store.get(id)._dragging = true;
    const box = store.selectionBox(ids);
    const parentId = store.get(ids[0]).parent;
    const exclude = [...ids, ...ids.flatMap((id) => store.descendants(id))];
    this.drag = {
      kind: 'move', ids, orig, box, layoutIds, exclude,
      targets: snapTargets(store, parentId, ids),
      startWorld: this.start.p,
    };
    store.overlay.dragging = true;
  }

  doMove(e, p) {
    const store = this.store;
    const d = this.drag;
    let dx = p.x - d.startWorld.x, dy = p.y - d.startWorld.y;
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const moved = { x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h };
    let guides = [];
    if (!e.mod) {
      const snap = snapBox(moved, d.targets, 5 / store.view.zoom);
      if (snap.snappedX && !(e.shift && dx === 0)) dx += snap.dx;
      if (snap.snappedY && !(e.shift && dy === 0)) dy += snap.dy;
      if (!snap.snappedX) dx += Math.round(d.box.x + dx) - (d.box.x + dx);
      if (!snap.snappedY) dy += Math.round(d.box.y + dy) - (d.box.y + dy);
      guides = snap.guides.filter((g) => (snap.snappedX && g.x1 === g.x2) || (snap.snappedY && g.y1 === g.y2));
    }
    for (const id of d.ids) {
      const n = store.get(id);
      const pd = store.worldDeltaToParent(n.parent, { x: dx, y: dy });
      store.moveBy(id, d.orig[id].x + pd.x - n.x, d.orig[id].y + pd.y - n.y);
    }

    // where would this land?
    const drop = frameAt(store, p, d.exclude);
    let insert = null;
    const first = d.ids[0];
    const container = effectiveContainer(store, first);
    if (drop && store.get(drop).layout) {
      const f = store.get(drop);
      const fp = store.worldToParent(drop, p);
      store.finalize();
      const wrapped = wrappedInsertion(store, f, fp, d.ids);
      d.insertIndex = wrapped?.index ?? insertionIndex(store, f, fp, d.ids);
      insert = this.insertMarker(f, d.insertIndex, d.ids, wrapped);
    }
    d.drop = drop;
    if (!insert) store.finalize();
    store.overlay.guides = guides;
    store.overlay.dropTarget = drop !== container ? drop : null;
    store.overlay.insert = insert;
    store.emit('doc');
  }

  insertMarker(f, idx, exclude, wrapped) {
    const store = this.store;
    const full = f.children.filter((id) => !exclude.includes(id));
    const kids = full.map((id) => store.get(id)).filter((c) => c.visible && !c.absolute);
    const before = store.get(full[idx]);
    const H = f.layout.mode === 'horizontal';
    const pad = f.layout.padding;
    let pos;
    if (!kids.length) pos = H ? f.x + pad.l : f.y + pad.t;
    else if (before) {
      const b = store.parentSpaceBox(before);
      pos = (H ? b.x : b.y) - (idx > 0 ? f.layout.gap / 2 : 0);
    } else {
      const b = store.parentSpaceBox(kids[kids.length - 1]);
      pos = (H ? b.x + b.w : b.y + b.h) + f.layout.gap / 2;
    }
    const m = store.matrix(f.id);
    const a = H ? { x: wrapped?.x ?? pos, y: wrapped?.top ?? f.y + pad.t } : { x: f.x + pad.l, y: pos };
    const b = H ? { x: wrapped?.x ?? pos, y: wrapped?.bottom ?? f.y + f.h - pad.b } : { x: f.x + f.w - pad.r, y: pos };
    const wa = G.apply(m, a), wb = G.apply(m, b);
    return { x1: wa.x, y1: wa.y, x2: wb.x, y2: wb.y };
  }

  endMove(d) {
    const store = this.store;
    const drop = d.drop === undefined ? null : d.drop;
    for (const id of d.ids) {
      const n = store.get(id);
      if (!n) continue;
      const container = effectiveContainer(store, id);
      const target = drop ? store.get(drop) : null;
      if (target && target.layout) {
        // insert into (or reorder within) an auto layout frame
        const list = target.children.filter((c) => !d.ids.includes(c));
        const before = list[d.insertIndex] || null;
        store.reparent(id, drop, null);
        const arr = target.children;
        arr.splice(arr.indexOf(id), 1);
        const at = before ? arr.indexOf(before) : arr.length;
        arr.splice(at, 0, id);
      } else if (drop !== container) {
        store.reparent(id, drop, null);
      }
      delete n._dragging;
    }
    for (const id of d.layoutIds) { const n = store.get(id); if (n) delete n._dragging; }
  }

  // ---------- resize ----------
  beginResize(handle, p, e) {
    const store = this.store;
    store.checkpoint();
    const ids = store.selection.slice();
    const snaps = ids.map((id) => store.cloneSubtree(id));
    const single = ids.length === 1;
    const n = store.get(ids[0]);
    this.drag = {
      kind: 'resize', handle, ids, snaps, single,
      orig: single ? { x: n.x, y: n.y, w: n.w, h: n.h, flipX: n.flipX, flipY: n.flipY } : null,
      origMatrix: single ? store.matrix(n.id) : null,
      box0: store.selectionBox(ids),
      targets: snapTargets(store, n.parent, ids),
      cursor: resizeCursor(0),
    };
    const h = handleAt(this.editor, e.screen);
    if (h && h.angle != null) this.drag.cursor = resizeCursor(h.angle);
    store.overlay.dragging = true;
  }

  restore(snaps) {
    const store = this.store;
    for (const list of snaps) for (const src of list) {
      const n = store.get(src.id);
      if (n) Object.assign(n, JSON.parse(JSON.stringify(src)), { parent: n.parent });
    }
  }

  doResize(e, p) {
    const store = this.store;
    const d = this.drag;
    this.restore(d.snaps);
    let guides = [];
    const unrotated = d.single ? !store.get(d.ids[0]).rotation && G.angleOf(store.parentMatrix(d.ids[0])) === 0 : true;
    if (unrotated && !e.mod) {
      const s = snapPoint(p, d.targets, 5 / store.view.zoom);
      const hx = /[ew]/.test(d.handle), hy = /[ns]/.test(d.handle);
      p = { x: hx && s.snappedX ? s.point.x : Math.round(p.x), y: hy && s.snappedY ? s.point.y : Math.round(p.y) };
      guides = s.guides.filter((g) => (hx && s.snappedX && g.x1 === g.x2 && Math.abs(g.x1 - p.x) < 0.5) || (hy && s.snappedY && g.y1 === g.y2 && Math.abs(g.y1 - p.y) < 0.5));
    }
    if (d.single) {
      const id = d.ids[0];
      const n = store.get(id);
      const shift = e.shift || this.scaleMode;
      const r = resizeSingle(store, id, d.orig, d.handle, p, { shift, alt: e.alt, origMatrix: d.origMatrix });
      if (n.type === 'text' && !this.scaleMode) {
        if (/[ew]/.test(d.handle) && n.text.autoResize === 'width') n.text.autoResize = 'height';
        if (/[ns]/.test(d.handle)) n.text.autoResize = 'fixed';
      }
      if (n.sizing) {
        if (/[ew]/.test(d.handle) && n.sizing.h !== 'fixed') n.sizing = { ...n.sizing, h: 'fixed' };
        if (/[ns]/.test(d.handle) && n.sizing.v !== 'fixed') n.sizing = { ...n.sizing, v: 'fixed' };
      }
      setBox(store, id, r.box, { scale: this.scaleMode });
      if (n.type !== 'text') {
        n.flipX = r.flipX ? !d.orig.flipX : d.orig.flipX;
        n.flipY = r.flipY ? !d.orig.flipY : d.orig.flipY;
      }
    } else {
      const B0 = d.box0;
      const B1 = this.rawBox(B0, d.handle, p, e);
      const sx = B1.w / (B0.w || 1), sy = B1.h / (B0.h || 1);
      for (const id of d.ids) {
        const n = store.get(id);
        const pm = store.parentMatrix(id);
        const c = G.apply(pm, { x: n.x + n.w / 2, y: n.y + n.h / 2 });
        const nc = { x: B1.x + (c.x - B0.x) * sx, y: B1.y + (c.y - B0.y) * sy };
        const lc = G.apply(G.invert(pm), nc);
        const w = n.w * sx, h = n.h * sy;
        if (n.type === 'text' && !this.scaleMode && n.text.autoResize !== 'fixed') {
          store.moveBy(id, lc.x - n.w / 2 - n.x, lc.y - n.h / 2 - n.y);
          continue;
        }
        setBox(store, id, { x: lc.x - w / 2, y: lc.y - h / 2, w: Math.max(0.01, w), h: Math.max(0.01, h) }, { scale: this.scaleMode, mode: 'scale' });
      }
    }
    store.finalize();
    store.overlay.guides = guides;
    store.emit('doc');
  }

  rawBox(B0, handle, p, e) {
    let x1 = B0.x, y1 = B0.y, x2 = B0.x + B0.w, y2 = B0.y + B0.h;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (handle.includes('e')) x2 = p.x;
    if (handle.includes('w')) x1 = p.x;
    if (handle.includes('s')) y2 = p.y;
    if (handle.includes('n')) y1 = p.y;
    if (e.alt) {
      if (handle.includes('e')) x1 = 2 * cx - x2;
      if (handle.includes('w')) x2 = 2 * cx - x1;
      if (handle.includes('s')) y1 = 2 * cy - y2;
      if (handle.includes('n')) y2 = 2 * cy - y1;
    }
    let w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
    if (e.shift || this.scaleMode) {
      const s = /[ns]/.test(handle) && !/[ew]/.test(handle) ? h / B0.h : /[ew]/.test(handle) && !/[ns]/.test(handle) ? w / B0.w : Math.max(w / B0.w, h / B0.h);
      w = B0.w * s; h = B0.h * s;
      if (handle.includes('w')) x1 = x2 - w; else if (!handle.includes('e')) x1 = cx - w / 2;
      if (handle.includes('n')) y1 = y2 - h; else if (!handle.includes('s')) y1 = cy - h / 2;
    }
    return { x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), w, h };
  }

  // ---------- rotate ----------
  beginRotate(p) {
    const store = this.store;
    store.checkpoint();
    const ids = store.selection.slice();
    const all = new Set(ids);
    for (const id of ids) for (const dd of store.descendants(id)) all.add(dd);
    const originals = {};
    for (const id of all) { const n = store.get(id); originals[id] = { x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation, flipX: n.flipX, flipY: n.flipY }; }
    let centre;
    if (ids.length === 1) {
      const n = store.get(ids[0]);
      centre = G.apply(store.matrix(n.id), { x: n.x + n.w / 2, y: n.y + n.h / 2 });
    } else {
      const b = store.selectionBox(ids);
      centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    const a0 = Math.atan2(p.y - centre.y, p.x - centre.x);
    this.drag = { kind: 'rotate', ids, originals, centre, a0, cursor: rotateCursor() };
    store.overlay.dragging = true;
  }

  doRotate(e, p) {
    const store = this.store;
    const d = this.drag;
    let delta = ((Math.atan2(p.y - d.centre.y, p.x - d.centre.x) - d.a0) * 180) / Math.PI;
    if (e.shift) {
      if (d.ids.length === 1 && store.get(d.ids[0]).type !== 'group') {
        const base = d.originals[d.ids[0]].rotation;
        delta = Math.round((base + delta) / 15) * 15 - base;
      } else delta = Math.round(delta / 15) * 15;
    }
    // restore, then rotate from the originals
    for (const id in d.originals) Object.assign(store.get(id), d.originals[id]);
    rotateNodes(store, d.ids, d.centre, delta, d.originals);
    store.finalize();
    store.emit('doc');
  }

  // ---------- line endpoints ----------
  beginEndpoint(which) {
    const store = this.store;
    store.checkpoint();
    const n = store.get(store.selection[0]);
    const m = store.matrix(n.id);
    this.drag = {
      kind: 'endpoint', id: n.id, which,
      fixed: G.apply(m, which === 'start' ? { x: n.x + n.w, y: n.y } : { x: n.x, y: n.y }),
      targets: snapTargets(store, n.parent, [n.id]),
      cursor: 'crosshair',
    };
  }

  doEndpoint(e, p) {
    const store = this.store;
    const d = this.drag;
    const n = store.get(d.id);
    if (e.shift) {
      const ang = Math.atan2(p.y - d.fixed.y, p.x - d.fixed.x);
      const snapA = (Math.round((ang * 180) / Math.PI / 45) * 45 * Math.PI) / 180;
      const len = Math.hypot(p.x - d.fixed.x, p.y - d.fixed.y);
      p = { x: d.fixed.x + Math.cos(snapA) * len, y: d.fixed.y + Math.sin(snapA) * len };
    } else if (!e.mod) {
      const s = snapPoint(p, d.targets, 5 / store.view.zoom);
      p = s.point;
      store.overlay.guides = s.guides.filter((g) => (s.snappedX && g.x1 === g.x2) || (s.snappedY && g.y1 === g.y2));
    }
    const inv = G.invert(store.parentMatrix(n.id));
    const a = G.apply(inv, d.which === 'start' ? p : d.fixed);
    const b = G.apply(inv, d.which === 'start' ? d.fixed : p);
    setLine(n, a, b);
    store.emit('doc');
  }

  // ---------- vector point editing ----------
  enterPathEdit(id) {
    this.store.setOverlay({ editingPath: id, pathPoint: null });
  }
  exitPathEdit() {
    const store = this.store;
    if (!store.overlay.editingPath) return;
    const n = store.get(store.overlay.editingPath);
    if (n) store.transact(() => normaliseVector(n));
    store.setOverlay({ editingPath: null, pathPoint: null });
  }
  downPathEdit(e, p) {
    const store = this.store;
    const n = store.get(store.overlay.editingPath);
    if (!n) return false;
    const m = store.matrix(n.id);
    const s = (q) => this.editor.toScreen(G.apply(m, { x: q.x + n.x, y: q.y + n.y }));
    for (let i = 0; i < n.points.length; i++) {
      const pt = n.points[i];
      for (const key of ['in', 'out']) {
        if (pt[key]) {
          const sp = s(pt[key]);
          if (Math.hypot(sp.x - e.screen.x, sp.y - e.screen.y) < 6) {
            store.checkpoint();
            this.drag = { kind: 'path-point', id: n.id, index: i, key, inv: G.invert(m) };
            return true;
          }
        }
      }
      const sp = s(pt);
      if (Math.hypot(sp.x - e.screen.x, sp.y - e.screen.y) < 7) {
        store.checkpoint();
        store.setOverlay({ pathPoint: i });
        this.drag = { kind: 'path-point', id: n.id, index: i, key: null, inv: G.invert(m) };
        return true;
      }
    }
    return false;
  }
  doPathPoint(e, p) {
    const store = this.store;
    const d = this.drag;
    const n = store.get(d.id);
    const lp = G.apply(d.inv, p);
    const q = { x: lp.x - n.x, y: lp.y - n.y };
    const pt = n.points[d.index];
    if (d.key) {
      pt[d.key] = q;
      if (!e.alt) {
        const other = d.key === 'in' ? 'out' : 'in';
        if (pt[other]) pt[other] = { x: 2 * pt.x - q.x, y: 2 * pt.y - q.y };
      }
    } else {
      const dx = q.x - pt.x, dy = q.y - pt.y;
      pt.x += dx; pt.y += dy;
      if (pt.in) { pt.in.x += dx; pt.in.y += dy; }
      if (pt.out) { pt.out.x += dx; pt.out.y += dy; }
    }
    store.emit('doc');
  }
}

export function setLine(n, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  n.w = Math.max(0.01, G.round(len));
  n.h = 0;
  n.x = cx - n.w / 2;
  n.y = cy;
  n.rotation = G.normAngle(G.round(ang));
  n.flipX = false; n.flipY = false;
}

/** Recomputes a vector's box from its points (points are relative to the box origin). */
export function normaliseVector(n) {
  if (!n.points || !n.points.length) return;
  const all = [];
  for (const p of n.points) { all.push(p); if (p.in) all.push(p.in); if (p.out) all.push(p.out); }
  const xs = n.points.map((p) => p.x), ys = n.points.map((p) => p.y);
  const b = G.aabb(all.map((p) => ({ x: p.x, y: p.y })));
  const minX = Math.min(b.x, ...xs), minY = Math.min(b.y, ...ys);
  if (Math.abs(minX) < 1e-6 && Math.abs(minY) < 1e-6 && Math.abs(b.w - n.w) < 1e-6 && Math.abs(b.h - n.h) < 1e-6) return;
  const shift = (p) => p && { x: p.x - minX, y: p.y - minY };
  // keep the drawing in place even when rotated: move the box by the shifted origin
  const oldC = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  n.points = n.points.map((p) => ({ x: p.x - minX, y: p.y - minY, in: shift(p.in), out: shift(p.out) }));
  n.x += minX; n.y += minY;
  n.w = Math.max(0.01, b.w); n.h = Math.max(0.01, b.h);
  if (n.rotation) {
    const newC = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    const r = (n.rotation * Math.PI) / 180;
    const vx = newC.x - oldC.x, vy = newC.y - oldC.y;
    const rx = vx * Math.cos(r) - vy * Math.sin(r), ry = vx * Math.sin(r) + vy * Math.cos(r);
    n.x += rx - vx; n.y += ry - vy;
  }
}

export { isLine };
