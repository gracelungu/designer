// Document commands shared by shortcuts, menus and panels. Each is one undo step.

import * as G from './geometry.js';
import { createNode, isFrameLike, solid } from './model.js';
import { guessLayout, defaultLayout } from './layout.js';

const paintOrder = (store, ids) => {
  const order = store.allIds();
  return ids.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
};

export function deleteSelection(store) {
  if (!store.selection.length) return;
  store.transact(() => {
    for (const id of store.selection.slice()) store.remove(id);
    store.selection = [];
  });
  store.emit('selection');
}

// ---------- clipboard ----------
export function copy(store, ids = store.selection) {
  ids = paintOrder(store, ids).filter((id) => store.get(id));
  if (!ids.length) return null;
  const nodes = [];
  const roots = [];
  for (const id of ids) {
    const list = store.cloneSubtree(id);
    // express the root in world space so it can be pasted anywhere
    const pm = store.parentMatrix(id);
    const r = list[0];
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const wc = G.apply(pm, c);
    const dx = wc.x - c.x, dy = wc.y - c.y;
    for (const n of list) { n.x += dx; n.y += dy; }
    r.rotation = G.normAngle(r.rotation + G.angleOf(pm));
    r.parent = null;
    roots.push(r.id);
    nodes.push(...list);
  }
  const assets = {};
  for (const n of nodes) for (const f of n.fills || []) if (f.asset && store.assets[f.asset]) assets[f.asset] = store.assets[f.asset];
  return { kind: 'designer/nodes', version: 1, nodes, roots, bounds: store.selectionBox(ids), assets, from: ids };
}

export function paste(store, payload, { viewportRect, intoSelection = true } = {}) {
  if (!payload || payload.kind !== 'designer/nodes') return [];
  Object.assign(store.assets, payload.assets || {});
  let parentId = null;
  const sel = store.selection.map((id) => store.get(id)).filter(Boolean);
  if (intoSelection && sel.length === 1 && isFrameLike(sel[0]) && !payload.from.includes(sel[0].id)) parentId = sel[0].id;
  else if (sel.length) parentId = sel[0].parent;
  if (parentId && store.get(parentId)?.type === 'group') parentId = store.get(parentId).parent;
  let ids;
  store.transact(() => {
    const index = parentId === (sel[0] && sel[0].parent) && sel.length ? store.indexInParent(paintOrder(store, store.selection).pop()) + 1 : null;
    const list = payload.nodes.map((n) => (payload.roots.includes(n.id) ? { ...n, parent: null } : n));
    ids = store.insertClones(list, parentId, index);
    const b = payload.bounds;
    const region = parentId ? store.worldBox(parentId) : viewportRect;
    let dx = 0, dy = 0;
    if (b && region && !G.boxContains(region, b)) {
      dx = Math.round(region.x + region.w / 2 - (b.x + b.w / 2));
      dy = Math.round(region.y + region.h / 2 - (b.y + b.h / 2));
    }
    // into a parent space (identity for unrotated parents)
    const inv = G.invert(store.spaceMatrix(parentId));
    for (const id of ids) {
      const n = store.get(id);
      const c = { x: n.x + n.w / 2 + dx, y: n.y + n.h / 2 + dy };
      const lc = G.apply(inv, c);
      store.moveBy(id, lc.x - (n.x + n.w / 2), lc.y - (n.y + n.h / 2));
      n.rotation = G.normAngle(n.rotation - G.angleOf(store.spaceMatrix(parentId)));
    }
    store.selection = ids;
  });
  store.emit('selection');
  return ids;
}

export function duplicate(store, { inPlace = false } = {}) {
  const ids = paintOrder(store, store.selection);
  if (!ids.length) return [];
  const out = [];
  store.transact(() => {
    for (const id of ids) {
      const n = store.get(id);
      const idx = store.indexInParent(id);
      const [nid] = store.insertClones(store.cloneSubtree(id), n.parent, idx + 1);
      if (!inPlace && !n.parent && isFrameLike(n)) store.moveBy(nid, n.w + 40, 0);
      out.push(nid);
    }
    store.selection = out;
  });
  store.emit('selection');
  return out;
}

// ---------- structure ----------
function wrap(store, type, props = {}) {
  const ids = paintOrder(store, store.selection);
  if (!ids.length) return null;
  const top = ids[ids.length - 1];
  const parentId = store.get(top).parent;
  let created;
  store.transact(() => {
    const idx = store.indexInParent(top);
    created = createNode(type, props);
    created.name = store.nextName(type);
    if (type === 'frame') {
      const b = store.selectionBox(ids);
      const inv = G.invert(store.spaceMatrix(parentId));
      const p = G.apply(inv, { x: b.x, y: b.y });
      Object.assign(created, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(b.w), h: Math.round(b.h) });
    }
    store.insert(created, parentId, idx + 1);
    for (const id of ids) store.reparent(id, created.id);
    store.selection = [created.id];
    if (props.onCreate) props.onCreate(created, ids);
  });
  store.emit('selection');
  return created;
}

export function group(store) {
  return wrap(store, 'group');
}

export function frameSelection(store) {
  return wrap(store, 'frame', { fills: [solid('#FFFFFF')], clip: false });
}

export function ungroup(store) {
  const targets = store.selected().filter((n) => n.children);
  if (!targets.length) return;
  const out = [];
  store.transact(() => {
    for (const g of targets) {
      const idx = store.indexInParent(g.id);
      const kids = g.children.slice();
      kids.forEach((cid, i) => {
        store.reparent(cid, g.parent, idx + 1 + i);
        out.push(cid);
      });
      store.remove(g.id);
    }
    store.selection = out;
  });
  store.emit('selection');
}

export function addAutoLayout(store) {
  const sel = store.selected();
  if (!sel.length) return;
  if (sel.length === 1 && sel[0].type === 'frame' && !sel[0].layout) {
    const f = sel[0];
    store.transact(() => {
      const kids = f.children.map((c) => store.get(c));
      const boxes = kids.map((c) => store.parentSpaceBox(c));
      const g = guessLayout(boxes);
      const L = defaultLayout(g.mode);
      L.gap = kids.length > 1 ? g.gap : 10;
      if (kids.length) {
        const u = G.unionBoxes(boxes);
        L.padding = {
          t: Math.max(0, Math.round(u.y - f.y)), l: Math.max(0, Math.round(u.x - f.x)),
          b: Math.max(0, Math.round(f.y + f.h - (u.y + u.h))), r: Math.max(0, Math.round(f.x + f.w - (u.x + u.w))),
        };
        const key = g.mode === 'horizontal' ? 'x' : 'y';
        f.children.sort((a, b) => store.get(a)[key] - store.get(b)[key]);
      }
      f.layout = L;
      f.sizing = { h: 'hug', v: 'hug' };
      if (!kids.length) f.sizing = { h: 'fixed', v: 'fixed' };
    });
    return;
  }
  const boxes = sel.map((n) => store.worldBox(n.id));
  const g = guessLayout(boxes);
  const key = g.mode === 'horizontal' ? 'x' : 'y';
  wrap(store, 'frame', {
    fills: [],
    clip: false,
    onCreate(frame, ids) {
      frame.layout = { ...defaultLayout(g.mode), gap: sel.length > 1 ? g.gap : 10, padding: { t: 0, r: 0, b: 0, l: 0 } };
      frame.sizing = { h: 'hug', v: 'hug' };
      frame.children.sort((a, b) => store.get(a)[key] - store.get(b)[key]);
    },
  });
}

export function removeAutoLayout(store) {
  const frames = store.selected().filter((n) => n.layout);
  if (!frames.length) return;
  store.transact(() => {
    for (const f of frames) {
      f.layout = null;
      f.sizing = { h: 'fixed', v: 'fixed' };
      for (const c of f.children) {
        const n = store.get(c);
        if (n.sizing) n.sizing = { h: n.sizing.h === 'fill' ? 'fixed' : n.sizing.h, v: n.sizing.v === 'fill' ? 'fixed' : n.sizing.v };
      }
    }
  });
}

export function reorder(store, how) {
  const ids = paintOrder(store, store.selection);
  if (!ids.length) return;
  store.transact(() => {
    const seq = how === 'forward' || how === 'front' ? ids.slice().reverse() : ids;
    for (const id of seq) {
      const n = store.get(id);
      const list = store.childIds(n.parent);
      const i = list.indexOf(id);
      list.splice(i, 1);
      let j = i;
      if (how === 'front') j = list.length;
      else if (how === 'back') j = 0;
      else if (how === 'forward') j = Math.min(list.length, i + 1);
      else if (how === 'backward') j = Math.max(0, i - 1);
      list.splice(j, 0, id);
    }
  });
}

// ---------- arrange ----------
export function align(store, how) {
  const ids = store.selection.filter((id) => store.get(id));
  if (!ids.length) return;
  let target;
  if (ids.length === 1) {
    const p = store.parent(ids[0]);
    if (!p || p.layout) return;
    target = store.worldBox(p.id);
  } else target = store.selectionBox(ids);
  store.transact(() => {
    for (const id of ids) {
      const n = store.get(id);
      const pn = store.parent(id);
      if (pn && pn.layout && !n.absolute) continue;
      const b = store.worldBox(id);
      let dx = 0, dy = 0;
      if (how === 'left') dx = target.x - b.x;
      if (how === 'right') dx = target.x + target.w - (b.x + b.w);
      if (how === 'hcenter') dx = target.x + target.w / 2 - (b.x + b.w / 2);
      if (how === 'top') dy = target.y - b.y;
      if (how === 'bottom') dy = target.y + target.h - (b.y + b.h);
      if (how === 'vcenter') dy = target.y + target.h / 2 - (b.y + b.h / 2);
      const d = store.worldDeltaToParent(n.parent, { x: Math.round(dx), y: Math.round(dy) });
      store.moveBy(id, d.x, d.y);
    }
  });
}

export function distribute(store, axis) {
  const ids = store.selection.filter((id) => store.get(id));
  if (ids.length < 3) return;
  const H = axis === 'h';
  const items = ids.map((id) => ({ id, b: store.worldBox(id) })).sort((a, b) => (H ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b, last = items[items.length - 1].b;
  const span = H ? last.x + last.w - first.x : last.y + last.h - first.y;
  const sum = items.reduce((s, it) => s + (H ? it.b.w : it.b.h), 0);
  const gap = (span - sum) / (items.length - 1);
  store.transact(() => {
    let cur = H ? first.x : first.y;
    for (const it of items) {
      const d = cur - (H ? it.b.x : it.b.y);
      const n = store.get(it.id);
      const pd = store.worldDeltaToParent(n.parent, H ? { x: d, y: 0 } : { x: 0, y: d });
      store.moveBy(it.id, pd.x, pd.y);
      cur += (H ? it.b.w : it.b.h) + gap;
    }
  });
}

export function tidyUp(store) {
  const ids = store.selection;
  if (ids.length < 2) return;
  const boxes = ids.map((id) => store.worldBox(id));
  const g = guessLayout(boxes);
  store.transact(() => {
    const items = ids.map((id, i) => ({ id, b: boxes[i] })).sort((a, b) => (g.mode === 'horizontal' ? a.b.x - b.b.x : a.b.y - b.b.y));
    const H = g.mode === 'horizontal';
    let cur = H ? items[0].b.x : items[0].b.y;
    const cross = H ? items[0].b.y : items[0].b.x;
    for (const it of items) {
      const n = store.get(it.id);
      const d = H ? { x: cur - it.b.x, y: cross - it.b.y } : { x: cross - it.b.x, y: cur - it.b.y };
      const pd = store.worldDeltaToParent(n.parent, d);
      store.moveBy(it.id, pd.x, pd.y);
      cur += (H ? it.b.w : it.b.h) + g.gap;
    }
  });
}

export function flip(store, axis) {
  const ids = store.selection;
  if (!ids.length) return;
  const centre = store.selectionBox(ids);
  const cx = centre.x + centre.w / 2, cy = centre.y + centre.h / 2;
  const flipOne = (id) => {
    const n = store.get(id);
    if (n.type === 'group') { n.children.forEach(flipOne); return; }
    const b = store.worldBox(id);
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const d = axis === 'x' ? { x: 2 * (cx - bx), y: 0 } : { x: 0, y: 2 * (cy - by) };
    const pd = store.worldDeltaToParent(n.parent, d);
    store.moveBy(id, pd.x, pd.y);
    if (axis === 'x') n.flipX = !n.flipX; else n.flipY = !n.flipY;
    n.rotation = G.normAngle(-n.rotation);
  };
  store.transact(() => ids.forEach(flipOne));
}

export function toggle(store, key) {
  const sel = store.selected();
  if (!sel.length) return;
  const value = key === 'visible' ? !sel.every((n) => !n.visible) ? false : true : !sel.every((n) => n.locked);
  store.transact(() => {
    for (const n of sel) n[key] = value;
    if (key === 'locked' && value) store.selection = [];
  });
  store.emit('selection');
}

export function setOpacity(store, v) {
  const sel = store.selected();
  if (!sel.length) return;
  store.transact(() => sel.forEach((n) => { n.opacity = v; }));
}

export function nudge(store, dx, dy) {
  const sel = store.selected();
  if (!sel.length) return;
  store.transact(() => {
    for (const n of sel) {
      const p = store.parent(n.id);
      if (p && p.layout && !n.absolute) {
        const H = p.layout.mode === 'horizontal';
        const dir = H ? Math.sign(dx) : Math.sign(dy);
        if (!dir) continue;
        const list = p.children;
        const i = list.indexOf(n.id);
        const j = Math.max(0, Math.min(list.length - 1, i + dir));
        list.splice(i, 1);
        list.splice(j, 0, n.id);
        continue;
      }
      const d = store.worldDeltaToParent(n.parent, { x: dx, y: dy });
      store.moveBy(n.id, d.x, d.y);
    }
  });
}

// ---------- selection navigation ----------
export function selectAll(store) {
  const first = store.get(store.selection[0]);
  const parent = first ? first.parent : null;
  store.select(store.childIds(parent).filter((id) => !store.get(id).locked && store.get(id).visible));
}
export function selectChildren(store) {
  const kids = store.selected().flatMap((n) => n.children || []);
  if (kids.length) store.select(kids);
}
export function selectParent(store) {
  const parents = [...new Set(store.selected().map((n) => n.parent).filter(Boolean))];
  store.select(parents);
}
export function selectSibling(store, dir) {
  const n = store.selected()[0];
  if (!n) return;
  const list = store.childIds(n.parent);
  const i = list.indexOf(n.id);
  // layer order on screen is top-first, so Tab moves "down" the layer list
  const j = (i - dir + list.length) % list.length;
  store.select([list[j]]);
}

// ---------- properties ----------
let propClipboard = null;
export function copyProperties(store) {
  const n = store.selected()[0];
  if (!n) return;
  propClipboard = JSON.parse(JSON.stringify({
    fills: n.fills, strokes: n.strokes, strokeWidth: n.strokeWidth, strokeAlign: n.strokeAlign,
    effects: n.effects, opacity: n.opacity, radius: n.radius, radii: n.radii,
    text: n.text ? { ...n.text, content: undefined } : undefined,
  }));
}
export function pasteProperties(store) {
  if (!propClipboard) return;
  store.transact(() => {
    for (const n of store.selected()) {
      const p = JSON.parse(JSON.stringify(propClipboard));
      if (n.type === 'text' && p.text) { const content = n.text.content; n.text = { ...p.text, content }; }
      delete p.text;
      Object.assign(n, p);
    }
  });
}

export function rename(store, id, name) {
  const n = store.get(id);
  if (!n || !name.trim() || n.name === name) return;
  store.transact(() => { n.name = name.trim(); n.userNamed = true; });
}
