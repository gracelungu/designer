// Layers panel: tree with expand/collapse, multi-select, rename, hide/lock, drag to reorder or nest.

import { h } from './dom.js';
import { ICONS, LAYER_ICON } from './icons.js';
import { rename } from '../core/commands.js';

export class LayersPanel {
  constructor(editor, el) {
    this.editor = editor;
    this.el = el;
    this.expanded = new Set();
    this._init = false;
    this.anchor = null;
    el.classList.add('dz-layers');
    editor.store.on((ch) => {
      if (ch.has('doc') || ch.has('selection') || ch.has('commit') || ch.has('overlay')) this.render(ch);
    });
    this.render(new Set(['doc']));
  }
  get store() { return this.editor.store; }

  rows() {
    const store = this.store;
    const out = [];
    const walk = (ids, depth) => {
      for (let i = ids.length - 1; i >= 0; i--) {
        const n = store.get(ids[i]);
        if (!n) continue;
        out.push({ n, depth });
        if (n.children && n.children.length && this.expanded.has(n.id)) walk(n.children, depth + 1);
      }
    };
    walk(store.doc.root, 0);
    return out;
  }

  render(ch) {
    const store = this.store;
    if (this.el.querySelector('input.dz-rename')) return;
    if (!this._init && store.doc.root.length) {
      this._init = true;
      for (const id of store.doc.root) if (store.get(id).type !== 'group') this.expanded.add(id);
    }
    if (ch.has('selection')) {
      // reveal selected layers
      for (const id of store.selection) for (const a of store.ancestors(id)) this.expanded.add(a.id);
    }
    const sig = JSON.stringify([store.selection, store.hover, [...this.expanded], this.rows().map((r) => [r.n.id, r.n.name, r.n.visible, r.n.locked, r.n.type, !!r.n.layout, r.n.layout?.mode, r.depth, !!(r.n.children && r.n.children.length)])]);
    if (sig === this._sig) return;
    this._sig = sig;
    const list = h('div', { class: 'dz-layer-list', role: 'tree' });
    const rows = this.rows();
    if (!rows.length) list.append(h('div', { class: 'dz-empty' }, 'No layers yet. Pick a tool below and draw on the canvas.'));
    for (const { n, depth } of rows) list.append(this.row(n, depth));
    const scrollTop = this.el.scrollTop;
    this.el.replaceChildren(list);
    this.el.scrollTop = scrollTop;
    if (ch.has('selection') && store.selection.length) {
      const el = this.el.querySelector(`[data-id="${store.selection[store.selection.length - 1]}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  row(n, depth) {
    const store = this.store;
    const selected = store.selection.includes(n.id);
    const inSelected = !selected && store.selection.some((s) => store.isAncestor(s, n.id));
    const hasKids = n.children && n.children.length > 0;
    const row = h('div', {
      class: `dz-layer${selected ? ' sel' : ''}${inSelected ? ' sub' : ''}${store.hover === n.id ? ' hover' : ''}${!n.visible ? ' hidden' : ''}${isTop(n) ? ' top' : ''}`,
      'data-id': n.id, role: 'treeitem', draggable: 'true', 'aria-selected': selected ? 'true' : 'false',
      style: { paddingLeft: 6 + depth * 14 + 'px' },
    });
    const caret = h('button', { class: 'dz-caret' + (hasKids ? '' : ' none') + (this.expanded.has(n.id) ? ' open' : ''), 'aria-label': 'Expand', html: hasKids ? ICONS.caret : '' });
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasKids) return;
      if (this.expanded.has(n.id)) this.expanded.delete(n.id); else this.expanded.add(n.id);
      this.render(new Set());
    });
    const icon = h('span', { class: 'dz-layer-icon', html: LAYER_ICON(n) });
    const name = h('span', { class: 'dz-layer-name' }, n.name);
    const lock = h('button', { class: 'dz-layer-act' + (n.locked ? ' pinned' : ''), title: n.locked ? 'Unlock' : 'Lock', html: n.locked ? ICONS.lock : ICONS.unlock });
    const eye = h('button', { class: 'dz-layer-act' + (!n.visible ? ' pinned' : ''), title: n.visible ? 'Hide' : 'Show', html: n.visible ? ICONS.eye : ICONS.eyeOff });
    lock.addEventListener('click', (e) => { e.stopPropagation(); store.transact(() => { n.locked = !n.locked; }); });
    eye.addEventListener('click', (e) => { e.stopPropagation(); store.transact(() => { n.visible = !n.visible; }); });
    row.append(caret, icon, name, h('span', { class: 'dz-layer-acts' }, lock, eye));

    row.addEventListener('pointerenter', () => store.setHover(n.id));
    row.addEventListener('pointerleave', () => store.setHover(null));
    row.addEventListener('click', (e) => this.click(n.id, e));
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); this.startRename(n.id, name); });

    // drag and drop
    row.addEventListener('dragstart', (e) => {
      if (!store.selection.includes(n.id)) store.select([n.id]);
      this.dragIds = store.selection.slice();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.id);
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragIds) return;
      e.preventDefault();
      const zone = this.zone(row, n, e);
      this.clearDrop();
      row.classList.add('drop-' + zone);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const zone = this.zone(row, n, e);
      this.clearDrop();
      this.drop(n, zone);
    });
    row.addEventListener('dragend', () => { this.dragIds = null; this.clearDrop(); });
    return row;
  }

  zone(row, n, e) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (n.children && y > 0.25 && y < 0.75) return 'inside';
    return y < 0.5 ? 'above' : 'below';
  }
  clearDrop() {
    this.el.querySelectorAll('.drop-above,.drop-below,.drop-inside').forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-inside'));
  }

  drop(target, zone) {
    const store = this.store;
    const ids = (this.dragIds || []).filter((id) => id !== target.id && !store.isAncestor(id, target.id));
    this.dragIds = null;
    if (!ids.length) return;
    store.transact(() => {
      // keep relative order: topmost first in the panel
      const order = store.allIds();
      ids.sort((a, b) => order.indexOf(b) - order.indexOf(a));
      for (const id of ids.slice().reverse()) {
        if (zone === 'inside') {
          store.reparent(id, target.id, null);
        } else {
          const parentId = target.parent;
          const list = store.childIds(parentId).filter((c) => c !== id);
          const ti = list.indexOf(target.id);
          // the panel shows the top of the stack first: "above" means a higher index
          const idx = zone === 'above' ? ti + 1 : ti;
          store.reparent(id, parentId, store.get(id).parent === parentId && store.indexInParent(id) <= idx ? idx + 1 : idx);
        }
      }
      store.selection = ids;
    });
    store.emit('selection');
  }

  click(id, e) {
    const store = this.store;
    if (e.shiftKey && this.anchor) {
      const rows = this.rows().map((r) => r.n.id);
      const a = rows.indexOf(this.anchor), b = rows.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
        const parent = store.get(id).parent;
        store.select(range.filter((r) => store.get(r).parent === parent));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) store.select([id], { toggle: true });
    else store.select([id]);
    this.anchor = id;
  }

  startRename(id, nameEl) {
    const store = this.store;
    const n = store.get(id);
    const input = h('input', { class: 'dz-rename', value: n.name, 'aria-label': 'Layer name' });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) rename(store, id, input.value);
      input.remove();
      this._sig = null;
      this.render(new Set(['doc']));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Tab') {
        e.preventDefault();
        finish(true);
        // Tab renames the next layer, like Figma
        const rows = this.rows().map((r) => r.n.id);
        const next = rows[rows.indexOf(id) + (e.shiftKey ? -1 : 1)];
        if (next) { store.select([next]); const el = this.el.querySelector(`[data-id="${next}"] .dz-layer-name`); if (el) this.startRename(next, el); }
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Cmd+R / F2 from the canvas. */
  renameSelected() {
    const id = this.store.selection[0];
    if (!id) return;
    const el = this.el.querySelector(`[data-id="${id}"] .dz-layer-name`);
    if (el) this.startRename(id, el);
  }
}

const isTop = (n) => !n.parent && (n.type === 'frame' || n.type === 'section');
