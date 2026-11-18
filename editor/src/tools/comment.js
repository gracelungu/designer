// Comment (C): click to pin a comment; pins follow the frame they were dropped on.
// Shift+C shows or hides comments outside comment mode.

import * as G from '../core/geometry.js';
import { hitTest } from '../core/hittest.js';
import { uid } from '../core/model.js';
import { escapeHTML } from '../render/text.js';

export class CommentTool {
  constructor(editor) {
    this.editor = editor;
    this.cursor = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 21V12a9 9 0 1 1 9 9Z" fill="#111" stroke="#fff" stroke-width="1.5"/><path d="M8 12h8M12 8v8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>')}") 2 22, crosshair`;
  }
  get store() { return this.editor.store; }
  activate() { this.editor.comments.render(); }
  deactivate() { this.editor.comments.closeDraft(); this.editor.comments.render(); }
  onHover() { this.store.setHover(null); }
  onDown(e, p) {
    if (this.editor.comments.openId || this.editor.comments.draft) {
      this.editor.comments.close();
      return;
    }
    this.editor.comments.startDraft(p, pinTarget(this.store, hitTest(this.store, p, 2)));
  }
}

/** The layer a comment pins to: the innermost frame (or live component) under the click, else the layer hit. */
export function pinTarget(store, chain) {
  if (!chain || !chain.length) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = store.get(chain[i]);
    if (n && (n.type === 'frame' || n.type === 'code')) return n.id;
  }
  return chain[chain.length - 1];
}

export class CommentLayer {
  constructor(editor) {
    this.editor = editor;
    this.el = document.createElement('div');
    this.el.className = 'dz-comments';
    editor.htmlEl.appendChild(this.el);
    this.draft = null;
    this.openId = null;
    this.showAlways = false;
    /** Name shown on new comments and replies; the host sets it (Designer uses the git user name). */
    this.author = 'You';
  }
  get store() { return this.editor.store; }
  get visible() { return this.store.tool === 'comment' || this.showAlways; }

  anchor(c) {
    const n = c.nodeId && this.store.get(c.nodeId);
    if (n) {
      const m = this.store.matrix(n.id);
      return G.apply(m, { x: n.x + c.dx, y: n.y + c.dy });
    }
    return { x: c.x, y: c.y };
  }

  startDraft(p, nodeId) {
    const n = nodeId && this.store.get(nodeId);
    let dx = 0, dy = 0;
    if (n) {
      const lp = G.apply(G.invert(this.store.matrix(n.id)), p);
      dx = lp.x - n.x; dy = lp.y - n.y;
    }
    this.draft = { x: p.x, y: p.y, nodeId: n ? n.id : null, dx, dy };
    this.openId = null;
    this.render();
    setTimeout(() => this.el.querySelector('textarea')?.focus(), 0);
  }
  closeDraft() { this.draft = null; }
  /** Opens a comment's thread, showing comments and bringing its pin into view. */
  open(id) {
    const c = this.store.doc.comments.find((x) => x.id === id);
    if (!c) return;
    this.draft = null;
    this.openId = id;
    this.showAlways = true;
    const a = this.anchor(c);
    const v = this.editor.viewRect();
    if (a.x < v.x || a.y < v.y || a.x > v.x + v.w - 300 || a.y > v.y + v.h) {
      const z = this.store.view.zoom;
      const r = this.editor.rect();
      this.store.setView({ zoom: z, x: r.width / 2 - 150 - a.x * z, y: r.height / 2 - a.y * z });
    }
    this.render();
  }
  close() { this.draft = null; this.openId = null; this.render(); }

  post(text) {
    if (!text.trim()) return;
    const store = this.store;
    const d = this.draft;
    const comments = store.doc.comments;
    const num = comments.reduce((m, c) => Math.max(m, c.num || 0), 0) + 1;
    store.transact(() => {
      comments.push({ id: uid(), num, x: d.x, y: d.y, nodeId: d.nodeId, dx: d.dx, dy: d.dy, author: this.author, text: text.trim(), at: Date.now(), replies: [], resolved: false });
    });
    this.draft = null;
    this.openId = comments[comments.length - 1].id;
    this.render();
  }

  pinnedName(c) {
    const n = c.nodeId && this.store.get(c.nodeId);
    return n ? n.name : '';
  }

  render() {
    const store = this.store;
    if (!this.visible) { this.el.innerHTML = ''; this._last = ''; return; }
    let html = '';
    for (const c of store.doc.comments) {
      if (c.resolved && this.openId !== c.id) continue;
      const s = this.editor.toScreen(this.anchor(c));
      html += `<button data-ui data-comment="${c.id}" class="dz-pin${this.openId === c.id ? ' on' : ''}" style="left:${s.x}px;top:${s.y}px">${c.num}</button>`;
      if (this.openId === c.id) {
        const all = [{ author: c.author, text: c.text, at: c.at }, ...c.replies];
        html += `<div data-ui class="dz-thread" style="left:${s.x + 36}px;top:${s.y - 30}px">
          <div class="dz-thread-head"><span>Comment #${c.num}${this.pinnedName(c) ? ` <span class="dz-on">on ${escapeHTML(this.pinnedName(c))}</span>` : ''}</span><span class="dz-thread-actions"><button data-act="resolve" title="${c.resolved ? 'Reopen' : 'Resolve'}">${c.resolved ? 'Reopen' : 'Resolve'}</button><button data-act="delete" title="Delete">Delete</button><button data-act="close" aria-label="Close">×</button></span></div>
          ${all.map((m) => `<div class="dz-msg"><div class="dz-msg-meta"><b>${escapeHTML(m.author)}</b> · ${timeAgo(m.at)}</div><div>${escapeHTML(m.text).replace(/\n/g, '<br>')}</div></div>`).join('')}
          <div class="dz-reply"><textarea rows="1" placeholder="Reply"></textarea><button data-act="reply" class="dz-post">Reply</button></div>
        </div>`;
      }
    }
    if (this.draft) {
      const s = this.editor.toScreen({ x: this.draft.x, y: this.draft.y });
      html += `<span data-ui class="dz-pin draft" style="left:${s.x}px;top:${s.y}px">+</span>`;
      html += `<div data-ui class="dz-thread" style="left:${s.x + 36}px;top:${s.y - 30}px"><div class="dz-reply"><textarea rows="2" placeholder="Add a comment"></textarea><button data-act="post" class="dz-post">Post</button></div></div>`;
    }
    if (html === this._last) return;
    this._last = html;
    const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
    const val = focused && focused.tagName === 'TEXTAREA' ? focused.value : null;
    this.el.innerHTML = html;
    if (val != null) { const t = this.el.querySelector('textarea'); if (t) { t.value = val; t.focus(); } }
    this.bind();
  }

  bind() {
    const store = this.store;
    this.el.querySelectorAll('[data-comment]').forEach((b) => b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.draft = null;
      this.openId = this.openId === b.dataset.comment ? null : b.dataset.comment;
      this.render();
    }));
    this.el.querySelectorAll('.dz-thread').forEach((t) => {
      t.addEventListener('pointerdown', (e) => e.stopPropagation());
      t.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          t.querySelector('[data-act="post"],[data-act="reply"]')?.click();
        }
        if (e.key === 'Escape') this.close();
      });
    });
    this.el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      const ta = b.closest('.dz-thread')?.querySelector('textarea');
      const c = store.doc.comments.find((x) => x.id === this.openId);
      if (act === 'post') return this.post(ta.value);
      if (act === 'close') return this.close();
      if (!c) return;
      if (act === 'reply' && ta.value.trim()) store.transact(() => c.replies.push({ author: this.author, text: ta.value.trim(), at: Date.now() }));
      if (act === 'resolve') { store.transact(() => { c.resolved = !c.resolved; }); if (c.resolved) this.openId = null; }
      if (act === 'delete') { store.transact(() => { store.doc.comments = store.doc.comments.filter((x) => x !== c); }); this.openId = null; }
      this.render();
    }));
  }
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}
