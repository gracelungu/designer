// Right panel: Design (position, layout, auto layout, appearance, text, fill, stroke,
// effects, export) and Inspect (CSS for developers). Multi-selection shows "Mixed".

import { h, toast, download } from './dom.js';
import { ICONS } from './icons.js';
import * as C from '../core/commands.js';
import { FRAME_PRESETS, FONTS, WEIGHTS, solid, stroke, shadow, isLine, isFrameLike, TYPE_LABEL } from '../core/model.js';
import { hasRadius } from '../core/paths.js';
import { setBox } from '../core/transform.js';
import { defaultLayout } from '../core/layout.js';
import { exportSVG } from '../render/scene.js';
import { cssFor } from './inspect.js';

const fmt = (v, p = 2) => {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const r = Math.round(v * 10 ** p) / 10 ** p;
  return String(r);
};
const same = (vals) => vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]));
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const normHex = (s) => {
  let v = s.trim().replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return '#' + v.toUpperCase();
};

function evalNumber(raw) {
  const s = String(raw).replace(/[%°a-z\s]/gi, '').replace(/,/g, '.');
  if (!s) return null;
  if (!/^[\d+\-*/().]+$/.test(s)) return null;
  try {
    // safe: only digits and arithmetic operators reach here
    const v = Function(`"use strict";return (${s})`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch { return null; }
}

export class PropertiesPanel {
  constructor(editor, el, { layers } = {}) {
    this.editor = editor;
    this.el = el;
    this.layers = layers;
    this.tab = 'design';
    this.ui = { corners: false, padding: false };
    el.classList.add('dz-props');
    this.head = h('div', { class: 'dz-tabs' });
    this.body = h('div', { class: 'dz-props-body' });
    el.append(this.head, this.body);
    this.renderTabs();
    editor.store.on((ch) => this.refresh(ch));
    this.refresh(new Set(['doc']));
  }
  get store() { return this.editor.store; }
  nodes() { return this.store.selected(); }

  renderTabs() {
    this.head.replaceChildren(
      ...['design', 'inspect'].map((t) => h('button', {
        class: 'dz-tab' + (this.tab === t ? ' on' : ''),
        onclick: () => { this.tab = t; this.renderTabs(); this._sig = null; this.refresh(new Set(['doc'])); },
      }, t === 'design' ? 'Design' : 'Inspect')),
    );
  }

  signature() {
    const s = this.store;
    return JSON.stringify([
      this.tab, s.tool === 'frame' ? 'frame' : '', s.selection, this.ui,
      this.nodes().map((n) => [
        n.type, (n.fills || []).map((f) => f.type), (n.strokes || []).length, (n.effects || []).map((e) => e.type),
        n.layout ? [n.layout.mode, n.layout.primary === 'space-between'] : null, !!n.radii, n.parent && s.get(n.parent)?.layout ? 1 : 0,
        n.parent ? s.get(n.parent)?.type : null, n.absolute, n.sizing, n.text && n.text.autoResize,
      ]),
      same(this.nodes().map((n) => n.fills)), same(this.nodes().map((n) => n.strokes)), same(this.nodes().map((n) => n.effects)),
    ]);
  }

  refresh(ch) {
    if (!ch.has('doc') && !ch.has('selection') && !ch.has('tool') && !ch.has('commit')) return;
    const sig = this.signature();
    if (sig !== this._sig || !this.binders) {
      this._sig = sig;
      this.build();
    } else {
      for (const b of this.binders) if (!b.el.contains(document.activeElement) || b.always) b.update();
    }
  }

  build() {
    const scroll = this.body.scrollTop;
    this.binders = [];
    const content = this.tab === 'inspect' ? this.inspect() : this.design();
    this.body.replaceChildren(...content);
    this.body.scrollTop = scroll;
  }

  // ---------- generic controls ----------
  /** Number field over a set of targets. getOne/setOne act per target; label scrubs. */
  num({ icon, label, title, targets, getOne, setOne, min = -Infinity, max = Infinity, step = 1, suffix = '', placeholder = '', width }) {
    const store = this.store;
    const input = h('input', { class: 'dz-num-input', 'aria-label': title || label || '', spellcheck: 'false' });
    const lab = h('span', { class: 'dz-num-label', html: icon || '', title });
    if (!icon) lab.textContent = label || '';
    const wrap = h('div', { class: 'dz-num', title }, lab, input);
    if (width) wrap.style.width = width;
    const value = () => {
      const ts = targets();
      if (!ts.length) return null;
      const vals = ts.map(getOne);
      return same(vals) ? vals[0] : 'mixed';
    };
    const show = () => {
      const v = value();
      input.value = v === 'mixed' || v == null || v === '' ? '' : fmt(v) + suffix;
      input.placeholder = v === 'mixed' ? 'Mixed' : placeholder;
    };
    const clampV = (v) => Math.max(min, Math.min(max, v));
    const setAll = (fn) => {
      for (const t of targets()) setOne(t, clampV(fn(t)));
    };
    const commitTyped = () => {
      const raw = input.value.trim();
      if (raw === '' && placeholder && value() !== 'mixed') {
        store.transact(() => setAll(() => null));
        show();
        return;
      }
      const v = evalNumber(raw);
      if (v == null) { show(); return; }
      const cur = value();
      if (cur !== 'mixed' && Math.abs((cur ?? 0) - v) < 1e-9) { show(); return; }
      store.transact(() => setAll(() => v));
      show();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { commitTyped(); input.select(); }
      if (e.key === 'Escape') { show(); input.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
        store.transact(() => setAll((t) => (getOne(t) ?? 0) + d));
        show();
      }
    });
    input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
    input.addEventListener('blur', commitTyped);
    lab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      lab.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const starts = new Map(targets().map((t) => [t, getOne(t) ?? 0]));
      store.checkpoint();
      const move = (ev) => {
        const d = Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1);
        for (const [t, v0] of starts) setOne(t, clampV(v0 + d));
        store.finalize();
        store.emit('doc');
        show();
      };
      const up = () => {
        lab.removeEventListener('pointermove', move);
        lab.removeEventListener('pointerup', up);
        store.commit();
      };
      lab.addEventListener('pointermove', move);
      lab.addEventListener('pointerup', up);
    });
    this.binders.push({ el: wrap, update: show });
    show();
    return wrap;
  }

  select(options, { get, set, title, cls = '' }) {
    const sel = h('select', { class: 'dz-select ' + cls, 'aria-label': title, title });
    for (const o of options) {
      if (o.group) {
        const g = h('optgroup', { label: o.group });
        for (const it of o.items) g.append(h('option', { value: it.value }, it.label));
        sel.append(g);
      } else sel.append(h('option', { value: o.value, disabled: o.disabled }, o.label));
    }
    const show = () => {
      const v = get();
      if (v === 'mixed') {
        if (!sel.querySelector('option[value="__mixed"]')) sel.prepend(h('option', { value: '__mixed', disabled: true }, 'Mixed'));
        sel.value = '__mixed';
      } else sel.value = String(v);
    };
    sel.addEventListener('change', () => { if (sel.value !== '__mixed') this.store.transact(() => set(sel.value)); });
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    this.binders.push({ el: sel, update: show });
    show();
    return sel;
  }

  iconToggle(icon, title, isOn, onClick) {
    const b = h('button', { class: 'dz-icon-btn', title, 'aria-label': title, html: icon });
    const show = () => b.classList.toggle('on', !!isOn());
    b.addEventListener('click', () => { onClick(); show(); });
    this.binders.push({ el: b, update: show, always: true });
    show();
    return b;
  }

  section(title, actions, ...rows) {
    return h('div', { class: 'dz-section' },
      h('div', { class: 'dz-section-head' }, h('span', {}, title), h('span', { class: 'dz-section-acts' }, ...(actions || []))),
      ...rows);
  }

  colorRow({ get, set, opacity, setOpacity, title = 'Colour' }) {
    const store = this.store;
    const swatchInput = h('input', { type: 'color', class: 'dz-swatch-input', 'aria-label': title });
    const swatch = h('label', { class: 'dz-swatch' }, swatchInput);
    const hex = h('input', { class: 'dz-hex', 'aria-label': title + ' hex', spellcheck: 'false' });
    const show = () => {
      const c = get();
      const o = opacity ? opacity() : 1;
      const mixed = c === 'mixed';
      hex.value = mixed ? '' : c.replace('#', '').toUpperCase();
      hex.placeholder = mixed ? 'Mixed' : '';
      swatch.style.setProperty('--c', mixed ? '#ccc' : c);
      swatch.style.setProperty('--o', o === 'mixed' ? 1 : o);
      if (!mixed) swatchInput.value = c.length === 7 ? c.toLowerCase() : '#000000';
    };
    swatchInput.addEventListener('input', () => {
      store.checkpoint();
      set(swatchInput.value.toUpperCase());
      store.finalize();
      store.emit('doc');
    });
    swatchInput.addEventListener('change', () => store.commit());
    hex.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
    hex.addEventListener('blur', () => {
      if (HEX.test(hex.value)) store.transact(() => set(normHex(hex.value)));
      show();
    });
    this.binders.push({ el: hex, update: show });
    const row = h('div', { class: 'dz-color' }, swatch, hex);
    if (opacity) {
      row.append(this.num({
        label: '', title: 'Opacity', suffix: '%', min: 0, max: 100, width: '52px',
        targets: () => [0], getOne: () => { const o = opacity(); return o === 'mixed' ? 'mixed' : Math.round(o * 100); },
        setOne: (_, v) => setOpacity(v / 100),
      }));
    }
    show();
    return row;
  }

  // ---------- Design tab ----------
  design() {
    const store = this.store;
    const nodes = this.nodes();
    if (store.tool === 'frame') return [this.presets()];
    if (!nodes.length) return this.pagePanel();
    const out = [];
    out.push(this.header(nodes));
    out.push(this.alignRow());
    out.push(this.positionSection(nodes));
    out.push(this.layoutSection(nodes));
    if (nodes.length === 1 && nodes[0].type === 'frame') out.push(this.autoLayoutSection(nodes[0]));
    out.push(this.appearanceSection(nodes));
    if (nodes.every((n) => n.type === 'text')) out.push(this.textSection(nodes));
    if (nodes.every((n) => n.type !== 'group')) {
      if (!nodes.some((n) => isLine(n))) out.push(this.paintSection(nodes, 'fills'));
      out.push(this.paintSection(nodes, 'strokes'));
    }
    out.push(this.effectsSection(nodes));
    out.push(this.exportSection(nodes));
    return out.filter(Boolean);
  }

  pagePanel() {
    const store = this.store;
    const page = store.doc.page;
    return [
      this.section('Page', null, this.colorRow({
        title: 'Canvas background',
        get: () => page.background,
        set: (c) => { page.background = c; },
      })),
      this.section('Get started', null, h('div', { class: 'dz-hint' },
        h('p', {}, 'Pick a tool in the bottom toolbar, or press its key: F frame, R rectangle, O ellipse, L line, P pen, T text, C comment.'),
        h('p', {}, 'Drag files onto the canvas to add images. Hold Space and drag to pan, Ctrl or ⌘ and scroll to zoom.'),
        h('button', { class: 'dz-btn', onclick: () => this.editor.showShortcuts && this.editor.showShortcuts() }, 'All keyboard shortcuts'))),
    ];
  }

  presets() {
    const ed = this.editor;
    const wrap = h('div', { class: 'dz-presets' });
    for (const g of FRAME_PRESETS) {
      wrap.append(h('div', { class: 'dz-preset-group' }, g.group));
      for (const p of g.items) {
        wrap.append(h('button', {
          class: 'dz-preset',
          onclick: () => createPresetFrame(ed, p),
        }, h('span', {}, p.name), h('span', { class: 'dz-muted' }, `${p.w}×${p.h}`)));
      }
    }
    return this.section('Frame', null, wrap);
  }

  header(nodes) {
    const store = this.store;
    const types = [...new Set(nodes.map((n) => n.type))];
    const title = nodes.length === 1 ? (nodes[0].type === 'frame' && nodes[0].layout ? 'Auto layout' : TYPE_LABEL[nodes[0].type]) : types.length === 1 ? `${nodes.length} ${TYPE_LABEL[types[0]].toLowerCase()}s` : `${nodes.length} layers`;
    const row = h('div', { class: 'dz-header' }, h('span', { class: 'dz-header-title' }, title));
    if (nodes.length === 1 && nodes[0].type === 'frame') {
      const n = nodes[0];
      const opts = [{ value: '', label: 'Resize to…' }, ...FRAME_PRESETS.map((g) => ({ group: g.group, items: g.items.map((p) => ({ value: `${p.w}x${p.h}`, label: `${p.name}  ${p.w}×${p.h}` })) }))];
      row.append(this.select(opts, {
        title: 'Frame preset',
        cls: 'dz-preset-select',
        get: () => '',
        set: (v) => {
          if (!v) return;
          const [w, hh] = v.split('x').map(Number);
          setBox(store, n.id, { x: n.x, y: n.y, w, h: hh });
          n.sizing = { h: 'fixed', v: 'fixed' };
        },
      }));
    }
    if (nodes.length > 1 || nodes[0].type !== 'frame') {
      row.append(this.iconToggle(ICONS.flipH, 'Flip horizontal (Shift+H)', () => false, () => C.flip(store, 'x')));
      row.append(this.iconToggle(ICONS.flipV, 'Flip vertical (Shift+V)', () => false, () => C.flip(store, 'y')));
    }
    return row;
  }

  alignRow() {
    const store = this.store;
    const b = (icon, title, fn) => h('button', { class: 'dz-icon-btn', title, 'aria-label': title, html: icon, onclick: fn });
    const many = store.selection.length > 2;
    return h('div', { class: 'dz-align' },
      b(ICONS.alignLeft, 'Align left (Alt+A)', () => C.align(store, 'left')),
      b(ICONS.alignHCenter, 'Align horizontal centers (Alt+H)', () => C.align(store, 'hcenter')),
      b(ICONS.alignRight, 'Align right (Alt+D)', () => C.align(store, 'right')),
      b(ICONS.alignTop, 'Align top (Alt+W)', () => C.align(store, 'top')),
      b(ICONS.alignVCenter, 'Align vertical centers (Alt+V)', () => C.align(store, 'vcenter')),
      b(ICONS.alignBottom, 'Align bottom (Alt+S)', () => C.align(store, 'bottom')),
      h('span', { class: 'dz-align-sep' }),
      many ? b(ICONS.distH, 'Distribute horizontal spacing (Alt+Shift+H)', () => C.distribute(store, 'h')) : null,
      many ? b(ICONS.distV, 'Distribute vertical spacing (Alt+Shift+V)', () => C.distribute(store, 'v')) : null,
      store.selection.length > 1 ? b(ICONS.tidy, 'Tidy up (Ctrl+Alt+T)', () => C.tidyUp(store)) : null,
    );
  }

  container(n) {
    let p = this.store.parent(n.id);
    while (p && p.type === 'group') p = this.store.parent(p.id);
    return p;
  }

  positionSection(nodes) {
    const store = this.store;
    const T = () => this.nodes();
    const rel = (n, axis) => { const c = this.container(n); return n[axis] - (c ? c[axis] : 0); };
    const move = (n, axis, v) => {
      const d = v - rel(n, axis);
      store.moveBy(n.id, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
    };
    const rows = [h('div', { class: 'dz-grid2' },
      this.num({ label: 'X', title: 'X position', targets: T, getOne: (n) => rel(n, 'x'), setOne: (n, v) => move(n, 'x', v) }),
      this.num({ label: 'Y', title: 'Y position', targets: T, getOne: (n) => rel(n, 'y'), setOne: (n, v) => move(n, 'y', v) }),
    )];
    if (!nodes.some((n) => n.type === 'group')) {
      rows.push(h('div', { class: 'dz-grid2' },
        this.num({ icon: ICONS.rotate, title: 'Rotation', suffix: '°', targets: T,
          getOne: (n) => (isLine(n) ? -n.rotation : -n.rotation) || 0,
          setOne: (n, v) => { n.rotation = ((-v + 540) % 360) - 180; } }),
        h('span'),
      ));
    }
    const parent = nodes.length === 1 ? this.container(nodes[0]) : null;
    if (parent && parent.layout) {
      rows.push(h('label', { class: 'dz-check' },
        h('input', { type: 'checkbox', checked: nodes[0].absolute, onchange: (e) => store.transact(() => { nodes[0].absolute = e.target.checked; }) }),
        'Ignore auto layout (absolute position)'));
    }
    if (parent && (!parent.layout || nodes[0].absolute) && parent.type === 'frame') {
      const n = nodes[0];
      rows.push(h('div', { class: 'dz-subhead' }, 'Constraints'));
      rows.push(h('div', { class: 'dz-grid2' },
        this.select([{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'leftright', label: 'Left and right' }, { value: 'center', label: 'Center' }, { value: 'scale', label: 'Scale' }],
          { title: 'Horizontal constraint', get: () => n.constraints?.h || 'left', set: (v) => { n.constraints = { ...n.constraints, h: v }; } }),
        this.select([{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }, { value: 'topbottom', label: 'Top and bottom' }, { value: 'center', label: 'Center' }, { value: 'scale', label: 'Scale' }],
          { title: 'Vertical constraint', get: () => n.constraints?.v || 'top', set: (v) => { n.constraints = { ...n.constraints, v: v }; } }),
      ));
    }
    return this.section('Position', null, ...rows);
  }

  layoutSection(nodes) {
    const store = this.store;
    const T = () => this.nodes();
    const resize = (n, key, v) => {
      if (isLine(n) && key === 'h') return;
      const box = { x: n.x, y: n.y, w: n.w, h: n.h };
      box[key] = Math.max(0.01, v);
      if (key === 'w' && n.text && n.text.autoResize === 'width') n.text.autoResize = 'height';
      if (key === 'h' && n.text) n.text.autoResize = 'fixed';
      if (n.sizing) n.sizing = { ...n.sizing, [key === 'w' ? 'h' : 'v']: 'fixed' };
      if (n.aspectLocked) {
        const r = n.w / n.h;
        if (key === 'w') box.h = box.w / r; else box.w = box.h * r;
      }
      if (isLine(n)) {
        const cx = n.x + n.w / 2;
        box.x = cx - box.w / 2;
      }
      setBox(store, n.id, box);
    };
    const row = h('div', { class: 'dz-grid2' },
      this.num({ label: 'W', title: 'Width', min: 0.01, targets: T, getOne: (n) => n.w, setOne: (n, v) => resize(n, 'w', v) }),
      this.num({ label: 'H', title: 'Height', min: 0.01, targets: () => T().filter((n) => !isLine(n)), getOne: (n) => n.h, setOne: (n, v) => resize(n, 'h', v) }),
    );
    const rows = [row];
    if (nodes.length === 1) {
      const n = nodes[0];
      const parentLayout = this.container(n)?.layout && !n.absolute;
      const canHug = (n.type === 'frame' && n.layout) || n.type === 'text';
      if (canHug || parentLayout) {
        const opts = (axis) => [
          { value: 'fixed', label: axis === 'h' ? 'Fixed width' : 'Fixed height' },
          canHug ? { value: 'hug', label: 'Hug contents' } : null,
          parentLayout ? { value: 'fill', label: 'Fill container' } : null,
        ].filter(Boolean);
        const getS = (axis) => {
          if (n.type === 'text' && n.sizing?.[axis] !== 'fill') {
            const mode = n.text.autoResize;
            if (axis === 'h') return mode === 'width' ? 'hug' : 'fixed';
            return mode === 'fixed' ? 'fixed' : 'hug';
          }
          return n.sizing?.[axis] || 'fixed';
        };
        const setS = (axis, v) => {
          n.sizing = { ...n.sizing, [axis]: v };
          if (n.type === 'text') {
            if (axis === 'h') n.text.autoResize = v === 'hug' ? 'width' : n.text.autoResize === 'width' ? 'height' : n.text.autoResize;
            if (axis === 'v') n.text.autoResize = v === 'hug' ? (n.text.autoResize === 'fixed' ? 'height' : n.text.autoResize) : v === 'fixed' ? 'fixed' : n.text.autoResize;
            if (v === 'hug') n.sizing[axis] = 'fixed';
          }
        };
        rows.push(h('div', { class: 'dz-grid2' },
          this.select(opts('h'), { title: 'Horizontal resizing', get: () => getS('h'), set: (v) => setS('h', v) }),
          this.select(opts('v'), { title: 'Vertical resizing', get: () => getS('v'), set: (v) => setS('v', v) }),
        ));
      }
      if (n.type === 'frame') {
        rows.push(h('label', { class: 'dz-check' },
          h('input', { type: 'checkbox', checked: !!n.clip, onchange: (e) => store.transact(() => { n.clip = e.target.checked; }) }),
          'Clip content'));
      }
    }
    return this.section('Layout', null, ...rows);
  }

  autoLayoutSection(f) {
    const store = this.store;
    if (!f.layout) {
      return this.section('Auto layout', [h('button', { class: 'dz-icon-btn', title: 'Add auto layout (Shift+A)', 'aria-label': 'Add auto layout', html: ICONS.plus, onclick: () => C.addAutoLayout(store) })]);
    }
    const L = () => store.get(f.id).layout;
    const dir = h('div', { class: 'dz-seg' },
      this.iconToggle(ICONS.layoutV, 'Vertical layout', () => L().mode === 'vertical', () => store.transact(() => { L().mode = 'vertical'; })),
      this.iconToggle(ICONS.layoutH, 'Horizontal layout', () => L().mode === 'horizontal', () => store.transact(() => { L().mode = 'horizontal'; })),
    );
    const grid = h('div', { class: 'dz-align-grid', role: 'group', 'aria-label': 'Alignment' });
    const pos = ['start', 'center', 'end'];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const horiz = () => L().mode === 'horizontal';
      const prim = () => (horiz() ? pos[c] : pos[r]);
      const cross = () => (horiz() ? pos[r] : pos[c]);
      const cell = h('button', { class: 'dz-cell', 'aria-label': `Align ${pos[r]} ${pos[c]}` });
      const show = () => {
        const l = L();
        if (!l) return;
        const sb = l.primary === 'space-between';
        const on = (sb || l.primary === prim()) && l.counter === cross();
        cell.classList.toggle('on', on && !(sb && (horiz() ? c !== 1 : r !== 1)));
        cell.classList.toggle('sb', sb && l.counter === cross());
      };
      cell.addEventListener('click', () => store.transact(() => {
        const l = L();
        if (l.primary !== 'space-between') l.primary = prim();
        l.counter = cross();
      }));
      this.binders.push({ el: cell, update: show, always: true });
      show();
      grid.append(cell);
    }
    const sb = L().primary === 'space-between';
    const gap = this.num({
      icon: L().mode === 'horizontal' ? ICONS.gapH : ICONS.gapV, title: 'Gap between items', min: 0,
      placeholder: sb ? 'Auto' : '', targets: () => [L()],
      getOne: (l) => (l.primary === 'space-between' ? '' : l.gap), setOne: (l, v) => { if (v != null) { l.gap = v; if (l.primary === 'space-between') l.primary = 'start'; } },
    });
    const autoGap = this.iconToggle(ICONS.distH, 'Auto spacing (space between)', () => L().primary === 'space-between', () => store.transact(() => { L().primary = L().primary === 'space-between' ? 'start' : 'space-between'; }));
    const pad = this.ui.padding
      ? h('div', { class: 'dz-grid2' },
        this.num({ icon: ICONS.padL, title: 'Left padding', min: 0, targets: () => [L()], getOne: (l) => l.padding.l, setOne: (l, v) => { l.padding.l = v; } }),
        this.num({ icon: ICONS.padT, title: 'Top padding', min: 0, targets: () => [L()], getOne: (l) => l.padding.t, setOne: (l, v) => { l.padding.t = v; } }),
        this.num({ icon: ICONS.padR, title: 'Right padding', min: 0, targets: () => [L()], getOne: (l) => l.padding.r, setOne: (l, v) => { l.padding.r = v; } }),
        this.num({ icon: ICONS.padB, title: 'Bottom padding', min: 0, targets: () => [L()], getOne: (l) => l.padding.b, setOne: (l, v) => { l.padding.b = v; } }))
      : h('div', { class: 'dz-grid2' },
        this.num({ icon: ICONS.padH, title: 'Horizontal padding', min: 0, targets: () => [L()], getOne: (l) => (l.padding.l === l.padding.r ? l.padding.l : 'mixed'), setOne: (l, v) => { l.padding.l = v; l.padding.r = v; } }),
        this.num({ icon: ICONS.padV, title: 'Vertical padding', min: 0, targets: () => [L()], getOne: (l) => (l.padding.t === l.padding.b ? l.padding.t : 'mixed'), setOne: (l, v) => { l.padding.t = v; l.padding.b = v; } }));
    const padToggle = this.iconToggle(ICONS.corners, 'Individual padding', () => this.ui.padding, () => { this.ui.padding = !this.ui.padding; this._sig = null; this.refresh(new Set(['doc'])); });
    return this.section('Auto layout',
      [h('button', { class: 'dz-icon-btn', title: 'Remove auto layout (Alt+Shift+A)', 'aria-label': 'Remove auto layout', html: ICONS.minus, onclick: () => C.removeAutoLayout(store) })],
      h('div', { class: 'dz-al' }, h('div', { class: 'dz-al-left' }, dir, h('div', { class: 'dz-gap-row' }, gap, autoGap)), grid),
      h('div', { class: 'dz-pad-row' }, pad, padToggle),
    );
  }

  appearanceSection(nodes) {
    const store = this.store;
    const T = () => this.nodes();
    const rows = [];
    const first = h('div', { class: 'dz-grid2' },
      this.num({ icon: ICONS.opacity, title: 'Opacity', suffix: '%', min: 0, max: 100, targets: T, getOne: (n) => Math.round(n.opacity * 100), setOne: (n, v) => { n.opacity = v / 100; } }));
    const radiusNodes = nodes.filter(hasRadius);
    if (radiusNodes.length === nodes.length) {
      if (this.ui.corners && nodes.length === 1) first.append(h('span'));
      else first.append(this.num({ icon: ICONS.radius, title: 'Corner radius', min: 0, targets: T,
        getOne: (n) => (n.radii ? (same(n.radii) ? n.radii[0] : 'mixed') : n.radius), setOne: (n, v) => { n.radius = v; n.radii = null; } }));
    } else first.append(h('span'));
    rows.push(first);
    if (radiusNodes.length === nodes.length && nodes.length === 1 && this.ui.corners) {
      const n = nodes[0];
      const corner = (i, label) => this.num({ label, title: `${label} radius`, min: 0, targets: () => [store.get(n.id)],
        getOne: (x) => (x.radii ? x.radii[i] : x.radius), setOne: (x, v) => { const r = x.radii || [x.radius, x.radius, x.radius, x.radius]; r[i] = v; x.radii = r.slice(); } });
      rows.push(h('div', { class: 'dz-grid2' }, corner(0, 'TL'), corner(1, 'TR'), corner(3, 'BL'), corner(2, 'BR')));
    }
    const polys = nodes.filter((n) => n.type === 'polygon' || n.type === 'star');
    if (polys.length === nodes.length) {
      const r = h('div', { class: 'dz-grid2' },
        this.num({ label: '#', title: 'Point count', min: 3, max: 60, targets: T, getOne: (n) => n.pointCount, setOne: (n, v) => { n.pointCount = Math.round(v); } }));
      if (nodes.every((n) => n.type === 'star')) r.append(this.num({ label: '%', title: 'Inner radius ratio', suffix: '%', min: 1, max: 100, targets: T, getOne: (n) => Math.round(n.innerRatio * 100), setOne: (n, v) => { n.innerRatio = v / 100; } }));
      rows.push(r);
    }
    const acts = radiusNodes.length === nodes.length && nodes.length === 1
      ? [this.iconToggle(ICONS.corners, 'Individual corners', () => this.ui.corners, () => { this.ui.corners = !this.ui.corners; this._sig = null; this.refresh(new Set(['doc'])); })]
      : [];
    rows.push(h('div', { class: 'dz-grid2' },
      this.iconToggle(nodes.every((n) => n.visible) ? ICONS.eye : ICONS.eyeOff, 'Show/hide (Shift+Ctrl+H)', () => !nodes.every((n) => n.visible), () => C.toggle(store, 'visible')),
      h('span')));
    rows.pop();
    return this.section('Appearance', [...acts, this.iconToggle(nodes.every((n) => n.visible) ? ICONS.eye : ICONS.eyeOff, 'Show or hide', () => false, () => C.toggle(store, 'visible'))], ...rows);
  }

  textSection(nodes) {
    const store = this.store;
    const T = () => this.nodes();
    const tval = (k) => { const v = this.nodes().map((n) => n.text[k]); return same(v) ? v[0] : 'mixed'; };
    const tset = (k, v) => { for (const n of this.nodes()) n.text[k] = v; };
    const family = this.select(FONTS.map((f) => ({ value: f, label: f })), { title: 'Font family', get: () => tval('fontFamily'), set: (v) => tset('fontFamily', v), cls: 'dz-wide' });
    const weight = this.select(WEIGHTS.map(([v, l]) => ({ value: String(v), label: l })), { title: 'Font weight', get: () => { const v = tval('fontWeight'); return v === 'mixed' ? v : String(v); }, set: (v) => tset('fontWeight', +v) });
    const size = this.num({ label: '', icon: ICONS.text, title: 'Font size', min: 1, targets: T, getOne: (n) => n.text.fontSize, setOne: (n, v) => { n.text.fontSize = v; } });
    const lh = this.num({ label: 'LH', title: 'Line height (empty for auto)', min: 0, placeholder: 'Auto', targets: T, getOne: (n) => n.text.lineHeight ?? '', setOne: (n, v) => { n.text.lineHeight = v || null; } });
    const ls = this.num({ label: 'LS', title: 'Letter spacing', suffix: '%', step: 0.5, targets: T, getOne: (n) => n.text.letterSpacing, setOne: (n, v) => { n.text.letterSpacing = v; } });
    const tg = (icon, title, k, v) => this.iconToggle(icon, title, () => tval(k) === v, () => store.transact(() => tset(k, v)));
    const decoTg = (icon, title, k) => this.iconToggle(icon, title, () => tval(k) === true, () => store.transact(() => tset(k, tval(k) !== true)));
    return this.section('Text', null,
      family,
      h('div', { class: 'dz-grid2' }, weight, size),
      h('div', { class: 'dz-grid2' }, lh, ls),
      h('div', { class: 'dz-row-btns' },
        h('div', { class: 'dz-seg' }, tg(ICONS.textLeft, 'Align left', 'align', 'left'), tg(ICONS.textCenter, 'Align center', 'align', 'center'), tg(ICONS.textRight, 'Align right', 'align', 'right')),
        h('div', { class: 'dz-seg' }, tg(ICONS.vTop, 'Align top', 'valign', 'top'), tg(ICONS.vMiddle, 'Align middle', 'valign', 'middle'), tg(ICONS.vBottom, 'Align bottom', 'valign', 'bottom'))),
      h('div', { class: 'dz-row-btns' },
        h('div', { class: 'dz-seg' }, tg(ICONS.autoW, 'Auto width', 'autoResize', 'width'), tg(ICONS.autoH, 'Auto height', 'autoResize', 'height'), tg(ICONS.fixedSize, 'Fixed size', 'autoResize', 'fixed')),
        h('div', { class: 'dz-seg' }, decoTg(ICONS.underline, 'Underline (Ctrl+U)', 'underline'), decoTg(ICONS.strike, 'Strikethrough', 'strike'),
          this.iconToggle('<b style="font:italic 600 13px Georgia">I</b>', 'Italic (Ctrl+I)', () => tval('italic') === true, () => store.transact(() => tset('italic', tval('italic') !== true))))),
      this.select([{ value: 'none', label: 'As typed' }, { value: 'upper', label: 'UPPERCASE' }, { value: 'lower', label: 'lowercase' }, { value: 'title', label: 'Title Case' }], { title: 'Letter case', get: () => tval('textCase'), set: (v) => tset('textCase', v) }),
    );
  }

  paintSection(nodes, key) {
    const store = this.store;
    const isFill = key === 'fills';
    const title = isFill ? 'Fill' : 'Stroke';
    const all = () => this.nodes();
    const identical = same(nodes.map((n) => n[key]));
    const add = () => store.transact(() => {
      for (const n of all()) {
        if (!identical) n[key] = [];
        n[key].unshift(isFill ? solid(n.type === 'text' ? '#000000' : n[key].length ? '#000000' : '#D9D9D9', 1) : stroke('#000000'));
        if (!isFill && !n.strokeWidth) n.strokeWidth = 1;
      }
    });
    const acts = [h('button', { class: 'dz-icon-btn', title: `Add ${title.toLowerCase()}`, 'aria-label': `Add ${title.toLowerCase()}`, html: ICONS.plus, onclick: add })];
    if (!identical) return this.section(title, acts, h('div', { class: 'dz-muted dz-pad' }, `Mixed ${title.toLowerCase()}s. Click + to replace them.`));
    const list = nodes[0][key] || [];
    const rows = list.map((p, i) => this.paintRow(key, i, p));
    if (!isFill && list.length) {
      const T = () => this.nodes();
      const extra = h('div', { class: 'dz-grid2' },
        this.num({ icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 4h12M2 8h12" stroke="currentColor" stroke-width="1"/><path d="M2 12h12" stroke="currentColor" stroke-width="2.5"/></svg>', title: 'Stroke weight', min: 0, targets: T, getOne: (n) => n.strokeWidth, setOne: (n, v) => { n.strokeWidth = v; } }),
      );
      if (nodes.every((n) => !isLine(n) && !(n.type === 'vector' && !n.closed))) {
        extra.append(this.select([{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }], {
          title: 'Stroke position', get: () => { const v = this.nodes().map((n) => n.strokeAlign); return same(v) ? v[0] : 'mixed'; }, set: (v) => this.nodes().forEach((n) => { n.strokeAlign = v; }),
        }));
      } else {
        extra.append(this.select([{ value: 'none', label: 'No end' }, { value: 'arrow', label: 'Arrow end' }], {
          title: 'Line end', get: () => { const v = this.nodes().map((n) => (n.type === 'arrow' || n.strokeCap === 'arrow' ? 'arrow' : 'none')); return same(v) ? v[0] : 'mixed'; },
          set: (v) => this.nodes().forEach((n) => { n.strokeCap = v; if (n.type === 'arrow' && v === 'none') n.type = 'line'; if (n.type === 'line' && v === 'arrow') n.type = 'arrow'; }),
        }));
      }
      rows.push(extra);
      rows.push(this.select([{ value: '', label: 'Solid' }, { value: '4 4', label: 'Dashed' }, { value: '1 3', label: 'Dotted' }], {
        title: 'Stroke style', get: () => { const v = this.nodes().map((n) => n.dashes || ''); return same(v) ? v[0] : 'mixed'; }, set: (v) => this.nodes().forEach((n) => { n.dashes = v || null; }),
      }));
    }
    return this.section(title, acts, ...rows);
  }

  paintRow(key, i, p) {
    const store = this.store;
    const all = () => this.nodes();
    const paint = (n) => n[key][i];
    const get = (k) => { const v = all().map((n) => paint(n)?.[k]); return same(v) ? v[0] : 'mixed'; };
    const set = (k, v) => all().forEach((n) => { if (paint(n)) paint(n)[k] = v; });
    const eye = h('button', { class: 'dz-icon-btn', title: p.visible === false ? 'Show' : 'Hide', html: p.visible === false ? ICONS.eyeOff : ICONS.eye,
      onclick: () => store.transact(() => set('visible', get('visible') === false)) });
    const del = h('button', { class: 'dz-icon-btn', title: 'Remove', html: ICONS.minus,
      onclick: () => store.transact(() => all().forEach((n) => n[key].splice(i, 1))) });
    let main;
    if (p.type === 'image') {
      const url = p.asset && store.assets[p.asset];
      main = h('div', { class: 'dz-color' },
        h('span', { class: 'dz-thumb', style: { backgroundImage: url ? `url(${url})` : 'none' } }),
        this.select([{ value: 'fill', label: 'Fill' }, { value: 'fit', label: 'Fit' }, { value: 'stretch', label: 'Stretch' }], { title: 'Image fit', get: () => get('fit'), set: (v) => set('fit', v) }),
        h('button', { class: 'dz-btn small', onclick: () => this.chooseImage((id) => store.transact(() => set('asset', id))) }, 'Replace'));
    } else {
      main = this.colorRow({
        get: () => get('color'), set: (c) => set('color', c),
        opacity: () => get('opacity'), setOpacity: (o) => set('opacity', o),
      });
    }
    const typeSel = key === 'fills' ? h('button', {
      class: 'dz-icon-btn' + (p.type === 'image' ? ' on' : ''), title: p.type === 'image' ? 'Use a solid colour' : 'Use an image', 'aria-label': 'Toggle image fill', html: ICONS.image,
      onclick: () => {
        if (p.type === 'image') { store.transact(() => all().forEach((n) => { n.fills[i] = solid('#D9D9D9'); })); return; }
        this.chooseImage((id) => store.transact(() => all().forEach((n) => { n.fills[i] = { type: 'image', asset: id, fit: 'fill', opacity: 1, visible: true }; })));
      },
    }) : null;
    return h('div', { class: 'dz-paint' + (p.visible === false ? ' off' : '') }, h('div', { class: 'dz-paint-main' }, main), typeSel, eye, del);
  }

  chooseImage(cb) {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const a = await this.editor.addAsset(f);
      cb(a.id);
    };
    input.click();
  }

  effectsSection(nodes) {
    const store = this.store;
    const identical = same(nodes.map((n) => n.effects));
    const add = () => store.transact(() => this.nodes().forEach((n) => { if (!identical) n.effects = []; n.effects.push(shadow('drop-shadow')); }));
    const acts = [h('button', { class: 'dz-icon-btn', title: 'Add effect', 'aria-label': 'Add effect', html: ICONS.plus, onclick: add })];
    if (!identical) return this.section('Effects', acts, h('div', { class: 'dz-muted dz-pad' }, 'Mixed effects. Click + to replace them.'));
    const rows = (nodes[0].effects || []).map((e, i) => {
      const all = () => this.nodes();
      const fx = (n) => n.effects[i];
      const get = (k) => { const v = all().map((n) => fx(n)?.[k]); return same(v) ? v[0] : 'mixed'; };
      const setK = (k, v) => all().forEach((n) => { if (fx(n)) fx(n)[k] = v; });
      const type = this.select([{ value: 'drop-shadow', label: 'Drop shadow' }, { value: 'inner-shadow', label: 'Inner shadow' }, { value: 'layer-blur', label: 'Layer blur' }], {
        title: 'Effect type', get: () => get('type'),
        set: (v) => all().forEach((n) => { const keep = n.effects[i].visible; n.effects[i] = { ...shadow(v), visible: keep }; }),
      });
      const eye = h('button', { class: 'dz-icon-btn', title: 'Show or hide', html: e.visible === false ? ICONS.eyeOff : ICONS.eye, onclick: () => store.transact(() => setK('visible', get('visible') === false)) });
      const del = h('button', { class: 'dz-icon-btn', title: 'Remove', html: ICONS.minus, onclick: () => store.transact(() => all().forEach((n) => n.effects.splice(i, 1))) });
      const T = () => this.nodes().map((n) => fx(n)).filter(Boolean);
      const params = e.type === 'layer-blur'
        ? h('div', { class: 'dz-grid2' }, this.num({ label: 'Blur', title: 'Blur', min: 0, targets: T, getOne: (x) => x.blur, setOne: (x, v) => { x.blur = v; } }))
        : h('div', { class: 'dz-fx-params' },
          h('div', { class: 'dz-grid2' },
            this.num({ label: 'X', title: 'Shadow X', targets: T, getOne: (x) => x.x, setOne: (x, v) => { x.x = v; } }),
            this.num({ label: 'Y', title: 'Shadow Y', targets: T, getOne: (x) => x.y, setOne: (x, v) => { x.y = v; } }),
            this.num({ label: 'Blur', title: 'Blur', min: 0, targets: T, getOne: (x) => x.blur, setOne: (x, v) => { x.blur = v; } }),
            this.num({ label: 'Spread', title: 'Spread', targets: T, getOne: (x) => x.spread, setOne: (x, v) => { x.spread = v; } })),
          this.colorRow({ get: () => get('color'), set: (c) => setK('color', c), opacity: () => get('opacity'), setOpacity: (o) => setK('opacity', o) }));
      return h('div', { class: 'dz-effect' + (e.visible === false ? ' off' : '') }, h('div', { class: 'dz-paint' }, h('div', { class: 'dz-paint-main' }, type), eye, del), params);
    });
    return this.section('Effects', acts, ...rows);
  }

  exportSection(nodes) {
    const store = this.store;
    const ids = nodes.map((n) => n.id);
    const name = nodes.length === 1 ? nodes[0].name : 'Selection';
    return this.section('Export', null, h('div', { class: 'dz-row-btns' },
      h('button', { class: 'dz-btn', onclick: () => download(`${name}.svg`, exportSVG(store, ids)) }, 'Export SVG'),
      h('button', { class: 'dz-btn', onclick: async () => {
        try { await navigator.clipboard.writeText(exportSVG(store, ids)); toast('Copied as SVG'); } catch { toast('Copy is blocked here. Use Export SVG.'); }
      } }, 'Copy as SVG')));
  }

  // ---------- Inspect tab ----------
  inspect() {
    const store = this.store;
    const nodes = this.nodes();
    if (!nodes.length) return [h('div', { class: 'dz-muted dz-pad' }, 'Select a layer to see its CSS.')];
    return nodes.slice(0, 5).map((n) => {
      const css = cssFor(store, n);
      const pre = h('pre', { class: 'dz-code' }, css);
      this.binders.push({ el: pre, update: () => { pre.textContent = cssFor(store, store.get(n.id) || n); } });
      return this.section(n.name, [h('button', { class: 'dz-btn small', onclick: async () => {
        try { await navigator.clipboard.writeText(pre.textContent); toast('CSS copied'); } catch { toast('Copy is blocked here. Select the text instead.'); }
      } }, 'Copy')], pre);
    });
  }
}

/** Adds a device frame next to existing content, like picking a preset in Figma. */
export function createPresetFrame(editor, p) {
  const store = editor.store;
  const roots = store.doc.root.map((id) => store.worldBox(id)).filter(Boolean);
  let x = 0, y = 0;
  if (roots.length) {
    const right = Math.max(...roots.map((b) => b.x + b.w));
    const top = Math.min(...roots.map((b) => b.y));
    x = Math.round(right + 100);
    y = Math.round(top);
  }
  let id;
  store.transact(() => {
    const n = store.create('frame', { x, y, w: p.w, h: p.h, name: p.name });
    id = n.id;
    store.selection = [id];
  });
  editor.setTool('move');
  store.emit('selection');
  const vr = editor.viewRect();
  const b = store.worldBox(id);
  if (!(b.x >= vr.x && b.y >= vr.y && b.x + b.w <= vr.x + vr.w && b.y + b.h <= vr.y + vr.h)) editor.zoomToBox(b, { max: 1 });
}

export { defaultLayout, isFrameLike };
