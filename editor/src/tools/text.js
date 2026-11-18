// Text (T): click for auto-width text, drag for a fixed-width box. Inline editing
// happens in a contenteditable laid exactly over the node.

import * as G from '../core/geometry.js';
import { hitTest, frameAt } from '../core/hittest.js';
import { textCSS } from '../render/text.js';

export class TextTool {
  constructor(editor) {
    this.editor = editor;
    this.cursor = 'text';
    this.drag = null;
  }
  get store() { return this.editor.store; }

  onHover(e, p) {
    const chain = hitTest(this.store, p, 2);
    const last = chain && this.store.get(chain[chain.length - 1]);
    this.store.setHover(last && last.type === 'text' ? last.id : null);
  }

  onDown(e, p) {
    const store = this.store;
    if (this.editor.textEditor.active) this.editor.textEditor.commit();
    const chain = hitTest(store, p, 2);
    const last = chain && store.get(chain[chain.length - 1]);
    if (last && last.type === 'text') {
      store.select([last.id]);
      this.editor.textEditor.start(last.id);
      this.drag = null;
      return;
    }
    this.drag = { start: { x: Math.round(p.x), y: Math.round(p.y) }, screen: e.screen, rect: null };
  }

  onMove(e, p) {
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(e.screen.x - d.screen.x, e.screen.y - d.screen.y) < 3) return;
    d.rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
    this.store.setOverlay({ marquee: d.rect });
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const store = this.store;
    store.setOverlay({ marquee: null });
    const at = d.rect ? { x: d.rect.x, y: d.rect.y } : { x: d.start.x, y: d.start.y - 10 };
    const parent = frameAt(store, at);
    store.checkpoint();
    const lp = store.worldToParent(parent, at);
    const n = store.create('text', { x: Math.round(lp.x), y: Math.round(lp.y), w: 1, h: 19, name: 'Text' }, parent);
    if (d.rect && d.rect.w > 4) {
      n.w = Math.round(d.rect.w);
      n.text.autoResize = d.rect.h > 24 ? 'fixed' : 'height';
      if (n.text.autoResize === 'fixed') n.h = Math.round(d.rect.h);
    }
    store.finalize();
    store.selection = [n.id];
    store.emit('selection');
    this.editor.textEditor.start(n.id, { isNew: true });
    this.editor.store.setTool('move');
  }
}

export class TextEditor {
  constructor(editor) {
    this.editor = editor;
    this.el = null;
    this.id = null;
  }
  get store() { return this.editor.store; }
  get active() { return !!this.id; }

  start(id, { isNew = false } = {}) {
    const store = this.store;
    const n = store.get(id);
    if (!n || n.type !== 'text' || store.isLocked(id)) return;
    if (this.active) this.commit();
    store.checkpoint();
    this.id = id;
    this.isNew = isNew;
    store.editingText = id;
    const el = document.createElement('div');
    el.className = 'dz-text-editor';
    el.setAttribute('data-ui', '');
    try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = false;
    el.textContent = n.text.content;
    this.editor.htmlEl.appendChild(el);
    this.el = el;
    el.addEventListener('input', () => {
      const node = store.get(this.id);
      if (!node) return;
      node.text.content = el.innerText.replace(/\n$/, '');
      if (!node.userNamed) node.name = node.text.content.slice(0, 40) || 'Text';
      store.finalize();
      store.emit('doc');
    });
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { e.preventDefault(); this.commit(); return; }
      if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const node = store.get(this.id);
        const k = e.key.toLowerCase();
        if (k === 'b') node.text.fontWeight = node.text.fontWeight >= 600 ? 400 : 700;
        if (k === 'i') node.text.italic = !node.text.italic;
        if (k === 'u') node.text.underline = !node.text.underline;
        store.finalize();
        store.emit('doc');
        this.position();
        return;
      }
      if (mod && e.key === 'Enter') { e.preventDefault(); this.commit(); }
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('blur', () => setTimeout(() => { if (this.el === el) this.commit(); }, 0));
    store.emit('doc');
    this.position();
    requestAnimationFrame(() => {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
  }

  position() {
    if (!this.el) return;
    const n = this.store.get(this.id);
    if (!n) { this.cancel(); return; }
    const m = G.multiply(this.editor.viewMatrix(), this.store.matrix(n.id));
    const t = G.multiply(m, G.translate(n.x, n.y));
    const width = n.text.autoResize === 'width' ? 'min-width:2px;width:max-content' : `width:${n.w}px`;
    const height = n.text.autoResize === 'fixed' ? `height:${n.h}px` : 'min-height:1em';
    this.el.style.cssText = `${textCSS(n)};${width};${height};position:absolute;left:0;top:0;transform-origin:0 0;transform:matrix(${t.join(',')});outline:none;caret-color:#0C8CE9;`;
  }

  commit() {
    const store = this.store;
    if (!this.id) return;
    const id = this.id;
    const el = this.el;
    this.id = null;
    this.el = null;
    store.editingText = null;
    const n = store.get(id);
    if (el) el.remove();
    if (n && !n.text.content.trim()) {
      store.remove(id);
      store.selection = store.selection.filter((s) => s !== id);
    } else if (n) store.selection = [id];
    store.commit();
    store.emit('selection');
    this.editor.root.focus({ preventScroll: true });
  }

  cancel() {
    if (this.el) this.el.remove();
    this.el = null;
    this.id = null;
    this.store.editingText = null;
  }
}
