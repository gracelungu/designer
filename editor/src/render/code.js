// The code layer: live renders of real code (a component or a page) placed on the canvas as layers.
//
// Each `code` node gets an <iframe> that sits between the scene and the selection overlay, moved
// with the camera, so selecting, moving and resizing work the same as for any shape. The page in
// the frame runs a small probe script (injected by the host) that reports the rendered size and,
// for Storybook stories, the component's props. Messages:
//   frame -> canvas: { source: 'designer-probe', type: 'size' | 'story' | 'args' | 'styles' | 'error', ... }
//   canvas -> frame: { target: 'designer-probe', type: 'set-args' | 'fixed-size' | 'hug' | 'styles?' , ... }

import * as G from '../core/geometry.js';

export class CodeLayer {
  constructor(editor) {
    this.editor = editor;
    this.el = document.createElement('div');
    this.el.className = 'dz-live';
    this.frames = new Map(); // node id -> { wrap, iframe, src, sentArgs, sentSize }
    this.info = new Map(); // node id -> { storyId, title, name, argTypes, args, initialArgs, styles, error }
    this.interacting = null;
    this.pill = document.createElement('div');
    this.pill.className = 'dz-live-pill';
    this.pill.setAttribute('data-ui', '');
    this.pill.innerHTML = '<span>Using the live component</span><button type="button">Done</button>';
    this.pill.querySelector('button').addEventListener('click', () => this.interact(null));
    this.onMessage = (e) => this.handleMessage(e);
    window.addEventListener('message', this.onMessage);
  }

  get store() { return this.editor.store; }

  /** Lets the pointer reach the live component (buttons, inputs, hover states) until Done or Esc. */
  interact(id) {
    this.interacting = id;
    this.render();
    if (id) this.frames.get(id)?.iframe.focus();
    else this.editor.root.focus({ preventScroll: true });
  }

  post(id, msg) {
    const f = this.frames.get(id);
    try { f?.iframe.contentWindow?.postMessage({ target: 'designer-probe', ...msg }, '*'); } catch { /* frame gone */ }
  }

  /** Sends the args the document asks for: the story's own defaults plus the props set on this layer. */
  syncArgs(id, force = false) {
    const n = this.store.get(id);
    const f = this.frames.get(id);
    const info = this.info.get(id);
    if (!n || !f || !info || !info.storyId) return;
    const want = JSON.stringify(n.code.args || {});
    if (!force && f.sentArgs === want) return;
    f.sentArgs = want;
    this.post(id, { type: 'set-args', args: { ...(info.initialArgs || {}), ...(n.code.args || {}) }, reset: true });
  }

  syncSize(id) {
    const n = this.store.get(id);
    const f = this.frames.get(id);
    if (!n || !f) return;
    const want = n.code.hug ? 'hug' : `${Math.round(n.w)}x${Math.round(n.h)}`;
    if (f.sentSize === want) return;
    f.sentSize = want;
    this.post(id, n.code.hug ? { type: 'hug' } : { type: 'fixed-size', w: n.w, h: n.h });
  }

  handleMessage(e) {
    const d = e.data;
    if (!d || d.source !== 'designer-probe') return;
    let id = null;
    for (const [k, f] of this.frames) if (f.iframe.contentWindow === e.source) id = k;
    if (!id) return;
    const n = this.store.get(id);
    if (!n) return;
    const info = this.info.get(id) || {};
    if (d.type === 'ready') {
      const f = this.frames.get(id);
      if (f) { f.sentSize = null; f.sentArgs = null; }
      this.syncSize(id);
    } else if (d.type === 'size') {
      info.measured = { w: d.w, h: d.h };
      if (n.code.hug && d.w > 0 && d.h > 0 && (Math.abs(n.w - d.w) > 0.5 || Math.abs(n.h - d.h) > 0.5)) {
        n.w = Math.ceil(d.w);
        n.h = Math.ceil(d.h);
        n.code.measured = { w: n.w, h: n.h };
        this.store.finalize();
        this.store.emit('doc');
      }
    } else if (d.type === 'story') {
      Object.assign(info, { storyId: d.storyId, title: d.title, name: d.name, argTypes: d.argTypes || {}, initialArgs: d.initialArgs || {}, args: d.args || {}, error: null });
      this.info.set(id, info);
      this.syncArgs(id, true);
    } else if (d.type === 'args') {
      info.args = d.args || {};
    } else if (d.type === 'styles') {
      info.styles = d.styles;
    } else if (d.type === 'error') {
      info.error = d.message;
    }
    this.info.set(id, info);
    this.store.emit('code');
  }

  /** A resize by hand turns hugging off, like Figma switching a layer from Hug to Fixed. */
  noteResize(n) {
    const m = n.code.measured;
    if (n.code.hug && m && (Math.abs(n.w - m.w) > 0.5 || Math.abs(n.h - m.h) > 0.5)) n.code.hug = false;
  }

  render() {
    const store = this.store;
    const view = this.editor.viewMatrix();
    const live = new Set();
    let prev = null;
    for (const id of store.allIds()) {
      const n = store.get(id);
      if (!n || n.type !== 'code') continue;
      live.add(id);
      let f = this.frames.get(id);
      if (!f) {
        const wrap = document.createElement('div');
        wrap.className = 'dz-live-node';
        const iframe = document.createElement('iframe');
        iframe.setAttribute('title', n.name);
        iframe.setAttribute('allowtransparency', 'true');
        iframe.setAttribute('scrolling', 'no');
        wrap.append(iframe);
        f = { wrap, iframe, src: null };
        this.frames.set(id, f);
      }
      // Keep paint order without touching frames already in place: moving an iframe reloads it.
      const want = prev ? prev.nextSibling : this.el.firstChild;
      if (want !== f.wrap) {
        if (f.wrap.isConnected && typeof this.el.moveBefore === 'function') this.el.moveBefore(f.wrap, want);
        else this.el.insertBefore(f.wrap, want);
      }
      prev = f.wrap;
      const src = n.code.src || 'about:blank';
      if (f.src !== src) {
        f.src = src;
        f.sentArgs = null;
        f.sentSize = null;
        f.iframe.src = src;
      }
      this.noteResize(n);
      const m = G.multiply(view, store.matrix(id));
      const tx = m[0] * n.x + m[2] * n.y + m[4];
      const ty = m[1] * n.x + m[3] * n.y + m[5];
      let opacity = 1;
      for (let p = n; p; p = p.parent ? store.get(p.parent) : null) opacity *= p.opacity ?? 1;
      const w = Math.max(1, n.w);
      Object.assign(f.wrap.style, {
        width: `${w}px`, height: `${Math.max(1, n.h)}px`,
        transform: `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${tx},${ty})`,
        opacity: String(opacity),
        display: store.isVisible(id) ? '' : 'none',
      });
      f.iframe.style.width = `${w}px`;
      f.iframe.style.height = `${Math.max(1, n.h)}px`;
      f.wrap.classList.toggle('interacting', this.interacting === id);
      f.wrap.classList.toggle('empty', !n.code.src);
      f.wrap.dataset.label = n.code.src ? '' : (n.code.title || n.name);
      this.syncSize(id);
      this.syncArgs(id);
    }
    for (const [id, f] of this.frames) if (!live.has(id)) { f.wrap.remove(); this.frames.delete(id); this.info.delete(id); }
    if (this.interacting && !live.has(this.interacting)) this.interacting = null;
    if (this.interacting) {
      const b = store.worldBox(this.interacting);
      const p = this.editor.toScreen({ x: b.x, y: b.y });
      Object.assign(this.pill.style, { left: `${p.x}px`, top: `${Math.max(8, p.y - 34)}px` });
      if (!this.pill.isConnected) this.editor.htmlEl.append(this.pill);
    } else this.pill.remove();
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.el.remove();
  }
}
