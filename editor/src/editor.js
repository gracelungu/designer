// The canvas editor: viewport, pointer routing, rendering and tool switching.
// Mount it into any element; panels and toolbars talk to it through `editor.store`.

import * as G from './core/geometry.js';
import { Store } from './core/store.js';
import { renderNodes } from './render/scene.js';
import { measureText } from './render/text.js';
import { renderOverlay } from './render/overlay.js';
import { SelectTool } from './tools/select.js';
import { ShapeTool } from './tools/shape.js';
import { PenTool } from './tools/pen.js';
import { PencilTool } from './tools/pencil.js';
import { TextTool, TextEditor } from './tools/text.js';
import { HandTool } from './tools/hand.js';
import { CommentTool, CommentLayer } from './tools/comment.js';

export const TOOL_INFO = {
  move: { label: 'Move', key: 'V' },
  hand: { label: 'Hand tool', key: 'H' },
  scale: { label: 'Scale', key: 'K' },
  frame: { label: 'Frame', key: 'F' },
  section: { label: 'Section', key: 'Shift S' },
  rect: { label: 'Rectangle', key: 'R' },
  line: { label: 'Line', key: 'L' },
  arrow: { label: 'Arrow', key: 'Shift L' },
  ellipse: { label: 'Ellipse', key: 'O' },
  polygon: { label: 'Polygon', key: '' },
  star: { label: 'Star', key: '' },
  image: { label: 'Place image', key: 'Shift ⌘ K' },
  pen: { label: 'Pen', key: 'P' },
  pencil: { label: 'Pencil', key: 'Shift P' },
  text: { label: 'Text', key: 'T' },
  comment: { label: 'Comment', key: 'C' },
};

export class Editor {
  constructor(root, { store } = {}) {
    this.root = root;
    this.store = store || new Store({ measureText });
    if (!this.store.measureText) this.store.measureText = measureText;
    this.keys = { space: false, alt: false, shift: false, mod: false };
    this.pointer = { x: 0, y: 0, world: { x: 0, y: 0 }, inside: false };
    this.pendingImages = [];

    root.classList.add('dz-canvas');
    root.tabIndex = 0;
    root.innerHTML = `
      <svg class="dz-scene" xmlns="http://www.w3.org/2000/svg"><defs></defs><g class="dz-world"></g></svg>
      <svg class="dz-overlay" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="dz-html"></div>`;
    this.sceneEl = root.querySelector('.dz-scene');
    this.defsEl = this.sceneEl.querySelector('defs');
    this.worldEl = this.sceneEl.querySelector('.dz-world');
    this.overlayEl = root.querySelector('.dz-overlay');
    this.htmlEl = root.querySelector('.dz-html');

    this.textEditor = new TextEditor(this);
    this.comments = new CommentLayer(this);
    this.tools = {
      move: new SelectTool(this),
      scale: new SelectTool(this, { scaleMode: true }),
      hand: new HandTool(this),
      pen: new PenTool(this),
      pencil: new PencilTool(this),
      text: new TextTool(this),
      comment: new CommentTool(this),
    };
    for (const t of ['frame', 'section', 'rect', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'image']) this.tools[t] = new ShapeTool(this, t);
    this.lastUsed = { move: 'move', frame: 'frame', shape: 'rect', draw: 'pen' };

    this._bind();
    this.store.on((changes) => this.render(changes));
    const ro = new ResizeObserver(() => { this.render(new Set(['view'])); });
    ro.observe(root);
    this.render(new Set(['doc', 'view']));
  }

  get tool() { return this.tools[this.activeToolId()] || this.tools.move; }
  activeToolId() { return this.keys.space && !this.textEditor.active ? 'hand' : this.store.tool; }

  setTool(id) {
    const prev = this.tools[this.store.tool];
    if (prev && prev.deactivate) prev.deactivate();
    if (this.textEditor.active && id !== 'text') this.textEditor.commit();
    this.store.setTool(id);
    const t = this.tools[id];
    if (t && t.activate) t.activate();
    if (['move', 'hand', 'scale'].includes(id)) this.lastUsed.move = id;
    if (['frame', 'section'].includes(id)) this.lastUsed.frame = id;
    if (['rect', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'image'].includes(id)) this.lastUsed.shape = id;
    if (['pen', 'pencil'].includes(id)) this.lastUsed.draw = id;
    this.updateCursor();
  }

  // ---------- coordinates ----------
  rect() { return this.root.getBoundingClientRect(); }
  toWorld(clientX, clientY) {
    const r = this.rect();
    const v = this.store.view;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }
  toScreen(p) {
    const v = this.store.view;
    return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
  }
  viewMatrix() { const v = this.store.view; return [v.zoom, 0, 0, v.zoom, v.x, v.y]; }
  viewRect() {
    const r = this.rect();
    const v = this.store.view;
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
  }

  // ---------- zoom ----------
  zoomAt(zoom, screen) {
    const v = this.store.view;
    zoom = G.clamp(zoom, 0.02, 256);
    const r = this.rect();
    const s = screen || { x: r.width / 2, y: r.height / 2 };
    const wx = (s.x - v.x) / v.zoom, wy = (s.y - v.y) / v.zoom;
    this.store.setView({ zoom, x: s.x - wx * zoom, y: s.y - wy * zoom });
  }
  zoomStep(dir) {
    const steps = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
    const z = this.store.view.zoom;
    const next = dir > 0 ? steps.find((s) => s > z * 1.001) || 256 : steps.slice().reverse().find((s) => s < z / 1.001) || 0.02;
    this.zoomAt(next);
  }
  zoomToBox(b, { max = 1, pad = 80 } = {}) {
    if (!b) return;
    const r = this.rect();
    const z = Math.min(max, (r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1));
    const zoom = G.clamp(z, 0.02, 256);
    this.store.setView({ zoom, x: r.width / 2 - (b.x + b.w / 2) * zoom, y: r.height / 2 - (b.y + b.h / 2) * zoom });
  }
  zoomToFit() { this.zoomToBox(this.store.selectionBox(this.store.doc.root), { max: 1 }); }
  zoomToSelection() {
    if (this.store.selection.length) this.zoomToBox(this.store.selectionBox(), { max: 256 });
    else this.zoomToFit();
  }

  // ---------- rendering ----------
  render(changes) {
    const v = this.store.view;
    if (changes.has('doc') || changes.has('selection') || changes.has('commit') || !this._rendered) {
      const { defs, body } = renderNodes(this.store, this.store.doc.root);
      this.defsEl.innerHTML = defs;
      this.worldEl.innerHTML = body;
      this.root.style.background = this.store.doc.page.background;
      this._rendered = true;
    }
    this.worldEl.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.zoom})`);
    this.overlayEl.innerHTML = renderOverlay(this);
    this.textEditor.position();
    this.comments.render();
    this.updateCursor();
  }

  updateCursor() {
    const t = this.tool;
    const c = (t.cursorAt && this.pointer.inside ? t.cursorAt(this.pointer.world) : null) || t.cursor || 'default';
    if (this.root.style.cursor !== c) this.root.style.cursor = c;
  }

  // ---------- input ----------
  _bind() {
    const el = this.root;
    let down = null;
    const ev = (e) => ({
      clientX: e.clientX, clientY: e.clientY,
      shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, button: e.button, detail: e.detail,
      screen: { x: e.clientX - this.rect().left, y: e.clientY - this.rect().top },
      target: e.target, raw: e,
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.dz-html [data-ui]')) return;
      if (this.textEditor.active && e.target.closest('.dz-text-editor')) return;
      el.focus({ preventScroll: true });
      const p = this.toWorld(e.clientX, e.clientY);
      if (e.button === 1 || (e.button === 0 && this.keys.space)) {
        down = { tool: this.tools.hand };
      } else if (e.button === 2) {
        return; // context menu handled separately
      } else down = { tool: this.tool };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      down.tool.onDown && down.tool.onDown(ev(e), p);
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.toWorld(e.clientX, e.clientY);
      this.pointer = { x: e.clientX, y: e.clientY, world: p, inside: true };
      this.keys.alt = e.altKey; this.keys.shift = e.shiftKey;
      if (down) down.tool.onMove && down.tool.onMove(ev(e), p);
      else {
        this.tool.onHover && this.tool.onHover(ev(e), p);
        if (this.keys.alt && this.store.selection.length) this.store.emit('overlay');
      }
      this.updateCursor();
    });
    const end = (e) => {
      if (!down) return;
      const d = down;
      down = null;
      d.tool.onUp && d.tool.onUp(ev(e), this.toWorld(e.clientX, e.clientY));
      this.updateCursor();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { this.pointer.inside = false; if (!down) this.store.setHover(null); });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.dz-html [data-ui]') || e.target.closest('.dz-text-editor')) return;
      const t = this.tool;
      t.onDoubleClick && t.onDoubleClick(ev(e), this.toWorld(e.clientX, e.clientY));
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.store.view;
      if (e.ctrlKey || e.metaKey) {
        const r = this.rect();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 4 : 1));
        this.zoomAt(v.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        const k = e.deltaMode === 1 ? 20 : 1;
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        this.store.setView({ x: v.x - dx * k, y: v.y - dy * k });
      }
    }, { passive: false });
    el.addEventListener('dragover', (e) => { e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) this.insertImages(files, this.toWorld(e.clientX, e.clientY));
    });
  }

  // ---------- images ----------
  readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  imageSize(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 100, h: img.naturalHeight || 100 });
      img.onerror = () => resolve({ w: 100, h: 100 });
      img.src = src;
    });
  }
  async addAsset(file) {
    const data = await this.readFile(file);
    const id = 'a' + Math.random().toString(36).slice(2, 10);
    this.store.assets[id] = data;
    const size = await this.imageSize(data);
    return { id, data, size };
  }
  /** Drops images at a world point (or the view centre), like dragging files into the canvas. */
  async insertImages(files, at) {
    const store = this.store;
    const vr = this.viewRect();
    let p = at || { x: vr.x + vr.w / 2, y: vr.y + vr.h / 2 };
    const ids = [];
    const assets = [];
    for (const f of files) assets.push(await this.addAsset(f));
    store.transact(() => {
      for (const a of assets) {
        let { w, h } = a.size;
        const max = Math.min(vr.w, vr.h) * 0.6;
        if (w > max || h > max) { const s = max / Math.max(w, h); w *= s; h *= s; }
        w = Math.round(w); h = Math.round(h);
        const n = store.create('image', { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, name: a.name || 'Image' });
        n.fills[0].asset = a.id;
        n.name = files[ids.length]?.name?.replace(/\.[^.]+$/, '') || n.name;
        ids.push(n.id);
        p = { x: p.x + 20, y: p.y + 20 };
      }
      store.selection = ids;
    });
    store.emit('selection');
  }
  /** Opens a file picker; images are then placed by clicking or dragging (Figma's place image). */
  pickImages() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = [...input.files];
      if (!files.length) return;
      this.pendingImages = [];
      for (const f of files) this.pendingImages.push({ ...(await this.addAsset(f)), name: f.name.replace(/\.[^.]+$/, '') });
      this.setTool('image');
    };
    input.click();
  }
}
