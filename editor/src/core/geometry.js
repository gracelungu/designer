// 2D affine matrices in SVG order [a, b, c, d, e, f]:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function apply(m, p) {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Applies only the linear part (no translation), for deltas. */
export function applyVec(m, v) {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export function rotate(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** Rotation (and flips) about a centre point. */
export function rotateAbout(deg, cx, cy, flipX = false, flipY = false) {
  let m = translate(cx, cy);
  m = multiply(m, rotate(deg));
  if (flipX || flipY) m = multiply(m, scale(flipX ? -1 : 1, flipY ? -1 : 1));
  return multiply(m, translate(-cx, -cy));
}

export function toSVG(m) {
  return `matrix(${m.map((v) => +v.toFixed(6)).join(' ')})`;
}

/** Rotation angle (deg) encoded in a matrix, ignoring flips. */
export function angleOf(m) {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

export function scaleOf(m) {
  return Math.hypot(m[0], m[1]);
}

export function boxCorners(b) {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

export function aabb(points) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of points) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  if (x1 === Infinity) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function unionBoxes(boxes) {
  const pts = [];
  for (const b of boxes) if (b) pts.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h });
  return aabb(pts);
}

export function boxesIntersect(a, b) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function boxContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function pointInBox(p, b, pad = 0) {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function normAngle(a) {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

export const round = (v, p = 2) => {
  const f = 10 ** p;
  return Math.round(v * f) / f;
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Ramer–Douglas–Peucker simplification for pencil strokes. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tolerance) return [a, b];
  const left = simplify(points.slice(0, idx + 1), tolerance);
  const right = simplify(points.slice(idx), tolerance);
  return left.slice(0, -1).concat(right);
}

/** Turns a polyline into smooth cubic vertices (Catmull-Rom) in our vector point format. */
export function smoothPoints(points) {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[i - 1] || p;
    const next = points[i + 1] || p;
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    return {
      x: p.x,
      y: p.y,
      in: i > 0 ? { x: p.x - tx, y: p.y - ty } : null,
      out: i < n - 1 ? { x: p.x + tx, y: p.y + ty } : null,
    };
  });
}
