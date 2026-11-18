// The editor store: document, selection, viewport, undo/redo, change events.
// Framework-free so the real app can wrap it in React or anything else.

import * as G from './geometry.js';
import { createNode, isContainer, uid, TYPE_LABEL } from './model.js';
import { layoutTree } from './layout.js';

const HISTORY_LIMIT = 200;

export function emptyDoc() {
  return { version: 1, name: 'Untitled', nodes: {}, root: [], comments: [], page: { name: 'Page 1', background: '#F5F5F5' } };
}

export class Store {
  constructor({ measureText } = {}) {
    this.doc = emptyDoc();
    this.assets = {}; // asset id -> data URL (kept out of undo snapshots)
    this.selection = [];
    this.hover = null;
    this.tool = 'move';
    this.view = { x: 0, y: 0, zoom: 1 };
    this.editingText = null;
    this.overlay = {}; // transient drawing state for tools (guides, marquee, previews)
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.listeners = new Set();
    this.measureText = measureText || null;
    this._scheduled = false;
    this._changes = new Set();
  }

  // ---------- events ----------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = 'doc') {
    this._changes.add(kind);
    if (this._scheduled) return;
    this._scheduled = true;
    const run = () => {
      this._scheduled = false;
      const changes = this._changes;
      this._changes = new Set();
      for (const fn of this.listeners) fn(changes);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }
  flush() {
    if (!this._changes.size) return;
    const changes = this._changes;
    this._changes = new Set();
    this._scheduled = false;
    for (const fn of this.listeners) fn(changes);
  }

  // ---------- reading ----------
  get(id) { return this.doc.nodes[id]; }
  childIds(parentId) { return parentId ? this.get(parentId)?.children || [] : this.doc.root; }
  parent(id) { const n = this.get(id); return n && n.parent ? this.get(n.parent) : null; }
  ancestors(id) {
    const out = [];
    let n = this.get(id);
    while (n && n.parent) { n = this.get(n.parent); out.push(n); }
    return out;
  }
  isAncestor(ancestorId, id) { return this.ancestors(id).some((a) => a.id === ancestorId); }
  descendants(id, out = []) {
    const n = this.get(id);
    if (n?.children) for (const c of n.children) { out.push(c); this.descendants(c, out); }
    return out;
  }
  /** All node ids in paint order (bottom to top), depth first. */
  allIds() {
    const out = [];
    const walk = (ids) => { for (const id of ids) { out.push(id); const n = this.get(id); if (n.children) walk(n.children); } };
    walk(this.doc.root);
    return out;
  }
  indexInParent(id) { const n = this.get(id); return this.childIds(n.parent).indexOf(id); }
  isVisible(id) {
    let n = this.get(id);
    while (n) { if (!n.visible) return false; n = n.parent ? this.get(n.parent) : null; }
    return true;
  }
  isLocked(id) {
    let n = this.get(id);
    while (n) { if (n.locked) return true; n = n.parent ? this.get(n.parent) : null; }
    return false;
  }
  selected() { return this.selection.map((id) => this.get(id)).filter(Boolean); }

  // ---------- transforms ----------
  localMatrix(n) {
    if (!n.rotation && !n.flipX && !n.flipY) return G.IDENTITY;
    return G.rotateAbout(n.rotation, n.x + n.w / 2, n.y + n.h / 2, n.flipX, n.flipY);
  }
  /** Maps a node's box coordinates to world coordinates. */
  matrix(id) {
    const n = this.get(id);
    if (!n) return G.IDENTITY;
    return G.multiply(this.parentMatrix(id), this.localMatrix(n));
  }
  /** Maps a node's parent-space coordinates to world coordinates. */
  parentMatrix(id) {
    const n = this.get(id);
    return n && n.parent ? this.matrix(n.parent) : G.IDENTITY;
  }
  spaceMatrix(parentId) { return parentId ? this.matrix(parentId) : G.IDENTITY; }
  worldCorners(id) {
    const n = this.get(id);
    const m = this.matrix(id);
    return G.boxCorners(n).map((p) => G.apply(m, p));
  }
  worldBox(id) { return G.aabb(this.worldCorners(id)); }
  selectionBox(ids = this.selection) {
    return G.unionBoxes(ids.filter((id) => this.get(id)).map((id) => this.worldBox(id)));
  }
  /** Box of a node in its parent's space, accounting for its own rotation. */
  parentSpaceBox(n) {
    const m = this.localMatrix(n);
    return G.aabb(G.boxCorners(n).map((p) => G.apply(m, p)));
  }
  worldToParent(parentId, p) { return G.apply(G.invert(this.spaceMatrix(parentId)), p); }
  worldDeltaToParent(parentId, d) { return G.applyVec(G.invert(this.spaceMatrix(parentId)), d); }

  // ---------- history ----------
  snapshot() {
    return JSON.stringify({ doc: this.doc, selection: this.selection });
  }
  /** Marks the start of an undoable change. Safe to call more than once. */
  checkpoint() {
    if (!this.pending) this.pending = this.snapshot();
  }
  /** Ends an undoable change, finalising layout and recording history. */
  commit() {
    this.finalize();
    if (!this.pending) { this.emit('doc'); return; }
    const before = this.pending;
    this.pending = null;
    const after = this.snapshot();
    if (before !== after && JSON.stringify(JSON.parse(before).doc) !== JSON.stringify(this.doc)) {
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit('doc');
    this.emit('commit');
  }
  cancel() {
    if (!this.pending) return;
    this.restore(this.pending);
    this.pending = null;
    this.emit('doc');
  }
  transact(fn) {
    this.checkpoint();
    const r = fn();
    this.commit();
    return r;
  }
  restore(snap) {
    const s = JSON.parse(snap);
    this.doc = s.doc;
    this.selection = (s.selection || []).filter((id) => this.doc.nodes[id]);
  }
  undo() {
    if (this.pending) this.cancel();
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
    this.editingText = null;
    this.emit('doc'); this.emit('selection'); this.emit('commit');
    return true;
  }
  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
    this.emit('doc'); this.emit('selection'); this.emit('commit');
    return true;
  }
  load(doc, assets = {}) {
    this.doc = doc;
    this.assets = assets;
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.finalize();
    this.emit('doc'); this.emit('selection');
  }

  // ---------- selection ----------
  select(ids, { add = false, toggle = false } = {}) {
    ids = ids.filter((id) => this.get(id));
    let next;
    if (toggle) {
      next = this.selection.slice();
      for (const id of ids) {
        const i = next.indexOf(id);
        if (i >= 0) next.splice(i, 1);
        else next.push(id);
      }
    } else if (add) next = [...new Set([...this.selection, ...ids])];
    else next = ids;
    // Never keep both a node and one of its ancestors.
    next = next.filter((id) => !next.some((o) => o !== id && this.isAncestor(o, id)));
    if (next.join() === this.selection.join()) return;
    this.selection = next;
    this.emit('selection');
  }
  setHover(id) {
    if (this.hover === id) return;
    this.hover = id;
    this.emit('overlay');
  }
  setTool(tool) {
    if (this.tool === tool) return;
    this.tool = tool;
    this.overlay = {};
    this.emit('tool');
  }
  setView(v) {
    Object.assign(this.view, v);
    this.view.zoom = G.clamp(this.view.zoom, 0.02, 256);
    this.emit('view');
  }
  setOverlay(o) { this.overlay = { ...this.overlay, ...o }; this.emit('overlay'); }

  // ---------- structure ----------
  nextName(type) {
    const label = TYPE_LABEL[type] || type;
    let max = 0;
    const re = new RegExp('^' + label + ' (\\d+)$');
    for (const id in this.doc.nodes) {
      const m = re.exec(this.doc.nodes[id].name);
      if (m) max = Math.max(max, +m[1]);
    }
    return `${label} ${max + 1}`;
  }
  create(type, props = {}, parentId = null, index = null) {
    const n = createNode(type, props);
    if (!props.name && type !== 'text') n.name = this.nextName(type);
    this.insert(n, parentId, index);
    return n;
  }
  insert(n, parentId = null, index = null) {
    this.doc.nodes[n.id] = n;
    n.parent = parentId;
    const list = this.childIds(parentId);
    if (index == null || index > list.length) list.push(n.id);
    else list.splice(Math.max(0, index), 0, n.id);
  }
  detach(id) {
    const n = this.get(id);
    const list = this.childIds(n.parent);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    return i;
  }
  remove(id) {
    const n = this.get(id);
    if (!n) return;
    this.detach(id);
    for (const d of this.descendants(id)) delete this.doc.nodes[d];
    delete this.doc.nodes[id];
    this.selection = this.selection.filter((s) => this.doc.nodes[s]);
  }
  /** Moves a node to another parent and index, keeping where it sits on screen. */
  reparent(id, parentId, index = null) {
    const n = this.get(id);
    if (!n) return;
    if (parentId && (parentId === id || this.isAncestor(id, parentId))) return;
    const oldM = this.parentMatrix(id);
    const centre = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    const worldC = G.apply(oldM, centre);
    const oldAngle = G.angleOf(oldM);
    const oldIndex = this.detach(id);
    if (n.parent === parentId && index != null && oldIndex >= 0 && oldIndex < index) index--;
    n.parent = parentId;
    const list = this.childIds(parentId);
    if (index == null || index > list.length) list.push(id);
    else list.splice(Math.max(0, index), 0, id);
    const newM = this.spaceMatrix(parentId);
    const newC = G.apply(G.invert(newM), worldC);
    this.moveBy(id, newC.x - centre.x, newC.y - centre.y);
    const dAngle = G.normAngle(oldAngle - G.angleOf(newM));
    if (Math.abs(dAngle) > 0.01) n.rotation = G.normAngle(n.rotation + dAngle);
  }

  // ---------- geometry edits ----------
  moveBy(id, dx, dy) {
    const n = this.get(id);
    if (!n || (!dx && !dy)) return;
    n.x += dx; n.y += dy;
    if (n.children) for (const c of n.children) this.moveBy(c, dx, dy);
  }
  update(id, props) {
    const n = this.get(id);
    if (n) Object.assign(n, props);
  }

  // ---------- derived state ----------
  /** Measures text, runs auto layout, and refits groups. Call after edits. */
  finalize() {
    const nodes = this.doc.nodes;
    if (this.measureText) {
      for (const id in nodes) {
        const n = nodes[id];
        if (n.type !== 'text') continue;
        const mode = n.text.autoResize;
        if (mode === 'fixed') continue;
        const size = this.measureText(n, mode === 'width' ? null : n.w);
        if (mode === 'width') {
          // keep the anchor implied by alignment when the width changes
          const dw = size.w - n.w;
          if (Math.abs(dw) > 0.01 && n.text.align === 'center') n.x -= dw / 2;
          else if (Math.abs(dw) > 0.01 && n.text.align === 'right') n.x -= dw;
          n.w = size.w;
        }
        n.h = size.h;
      }
    }
    this.fitGroups();
    layoutTree(this);
    this.fitGroups();
  }
  fitGroups() {
    const walk = (ids) => {
      for (const id of ids) {
        const n = this.get(id);
        if (!n) continue;
        if (n.children) walk(n.children);
        if (n.type === 'group') {
          if (!n.children.length) { this.remove(id); continue; }
          const b = G.unionBoxes(n.children.map((c) => this.parentSpaceBox(this.get(c))));
          if (b) Object.assign(n, b);
        }
      }
    };
    walk(this.doc.root.slice());
  }

  // ---------- serialisation helpers ----------
  cloneSubtree(id) {
    const out = [];
    const walk = (i) => { const n = this.get(i); out.push(JSON.parse(JSON.stringify(n))); if (n.children) n.children.forEach(walk); };
    walk(id);
    return out;
  }
  /** Inserts cloned nodes with fresh ids. Returns new root ids. */
  insertClones(list, parentId, index = null) {
    const map = {};
    for (const n of list) map[n.id] = uid();
    const ids = new Set(list.map((n) => n.id));
    const roots = [];
    for (const src of list) {
      const n = JSON.parse(JSON.stringify(src));
      n.id = map[src.id];
      if (n.children) n.children = n.children.filter((c) => map[c]).map((c) => map[c]);
      if (src.parent && ids.has(src.parent)) {
        n.parent = map[src.parent];
        this.doc.nodes[n.id] = n;
      } else {
        roots.push(n.id);
        this.insert(n, parentId, index == null ? null : index + roots.length - 1);
      }
    }
    return roots;
  }
}

export const isTextual = (n) => n && n.type === 'text';
export { isContainer };
