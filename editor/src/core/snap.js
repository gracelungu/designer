// Snapping and smart guides: edges and centres of siblings and the parent frame.

const lines = (b) => ({
  x: [b.x, b.x + b.w / 2, b.x + b.w],
  y: [b.y, b.y + b.h / 2, b.y + b.h],
});

export function snapTargets(store, parentId, excludeIds) {
  const ex = new Set(excludeIds);
  for (const id of excludeIds) for (const d of store.descendants(id)) ex.add(d);
  const boxes = [];
  for (const id of store.childIds(parentId)) {
    const n = store.get(id);
    if (!n || ex.has(id) || !n.visible) continue;
    boxes.push(store.worldBox(id));
    // also the children of top-level frames, so things line up with content
  }
  if (parentId && !ex.has(parentId)) {
    const p = store.get(parentId);
    if (p && p.type !== 'group') boxes.push(store.worldBox(parentId));
    else if (p) {
      // inside a group, snap to the group's siblings too
      return boxes.concat(snapTargets(store, p.parent, [...excludeIds, parentId]));
    }
  }
  return boxes;
}

function bestOffset(values, targets, threshold) {
  let best = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/** Snaps a moving box. Returns the extra offset to apply and guide lines (world coords). */
export function snapBox(box, targets, threshold) {
  const L = lines(box);
  const tx = targets.flatMap((b) => lines(b).x);
  const ty = targets.flatMap((b) => lines(b).y);
  const dx = bestOffset(L.x, tx, threshold);
  const dy = bestOffset(L.y, ty, threshold);
  const snapped = { x: box.x + (dx || 0), y: box.y + (dy || 0), w: box.w, h: box.h };
  return { dx: dx || 0, dy: dy || 0, snappedX: dx !== null, snappedY: dy !== null, guides: guidesFor(snapped, targets) };
}

/** Snaps a single point (drawing, resizing). */
export function snapPoint(p, targets, threshold) {
  const tx = targets.flatMap((b) => lines(b).x);
  const ty = targets.flatMap((b) => lines(b).y);
  const dx = bestOffset([p.x], tx, threshold);
  const dy = bestOffset([p.y], ty, threshold);
  const q = { x: p.x + (dx || 0), y: p.y + (dy || 0) };
  return { point: q, snappedX: dx !== null, snappedY: dy !== null, guides: guidesFor({ x: q.x, y: q.y, w: 0, h: 0 }, targets) };
}

export function guidesFor(box, targets) {
  const L = lines(box);
  const out = [];
  const eps = 0.5;
  for (const v of L.x) {
    let y1 = Infinity, y2 = -Infinity, hit = false;
    for (const t of targets) {
      if (lines(t).x.some((x) => Math.abs(x - v) < eps)) {
        hit = true;
        y1 = Math.min(y1, t.y, box.y);
        y2 = Math.max(y2, t.y + t.h, box.y + box.h);
      }
    }
    if (hit) out.push({ x1: v, y1, x2: v, y2 });
  }
  for (const v of L.y) {
    let x1 = Infinity, x2 = -Infinity, hit = false;
    for (const t of targets) {
      if (lines(t).y.some((y) => Math.abs(y - v) < eps)) {
        hit = true;
        x1 = Math.min(x1, t.x, box.x);
        x2 = Math.max(x2, t.x + t.w, box.x + box.w);
      }
    }
    if (hit) out.push({ x1, y1: v, x2, y2: v });
  }
  return out;
}
