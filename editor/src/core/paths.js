// SVG path data for each node, in the node's own box coordinates (x..x+w, y..y+h).

const f = (v) => +v.toFixed(3);

export function cornerRadii(n) {
  const max = Math.min(Math.abs(n.w), Math.abs(n.h)) / 2;
  const r = n.radii || [n.radius || 0, n.radius || 0, n.radius || 0, n.radius || 0];
  return r.map((v) => Math.max(0, Math.min(max, v || 0)));
}

export function rectPath(x, y, w, h, radii = [0, 0, 0, 0]) {
  const [tl, tr, br, bl] = radii;
  if (!tl && !tr && !br && !bl) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  return [
    `M${f(x + tl)} ${f(y)}`,
    `H${f(x + w - tr)}`,
    tr ? `A${f(tr)} ${f(tr)} 0 0 1 ${f(x + w)} ${f(y + tr)}` : '',
    `V${f(y + h - br)}`,
    br ? `A${f(br)} ${f(br)} 0 0 1 ${f(x + w - br)} ${f(y + h)}` : '',
    `H${f(x + bl)}`,
    bl ? `A${f(bl)} ${f(bl)} 0 0 1 ${f(x)} ${f(y + h - bl)}` : '',
    `V${f(y + tl)}`,
    tl ? `A${f(tl)} ${f(tl)} 0 0 1 ${f(x + tl)} ${f(y)}` : '',
    'Z',
  ].join('');
}

function ellipsePath(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}

/** Regular polygon or star vertices stretched to fill the box exactly. */
export function polyPoints(n) {
  const count = Math.max(3, Math.round(n.pointCount || 3));
  const star = n.type === 'star';
  const pts = [];
  const total = star ? count * 2 : count;
  for (let i = 0; i < total; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / total;
    const r = star && i % 2 ? n.innerRatio ?? 0.382 : 1;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return pts.map((p) => ({
    x: n.x + ((p.x - minX) / (maxX - minX || 1)) * n.w,
    y: n.y + ((p.y - minY) / (maxY - minY || 1)) * n.h,
  }));
}

export function vectorPath(points, closed, ox = 0, oy = 0) {
  if (!points.length) return '';
  let d = `M${f(points[0].x + ox)} ${f(points[0].y + oy)}`;
  const seg = (a, b) => {
    if (!a.out && !b.in) return `L${f(b.x + ox)} ${f(b.y + oy)}`;
    const c1 = a.out || a, c2 = b.in || b;
    return `C${f(c1.x + ox)} ${f(c1.y + oy)} ${f(c2.x + ox)} ${f(c2.y + oy)} ${f(b.x + ox)} ${f(b.y + oy)}`;
  };
  for (let i = 1; i < points.length; i++) d += seg(points[i - 1], points[i]);
  if (closed && points.length > 2) d += seg(points[points.length - 1], points[0]) + 'Z';
  return d;
}

export function linePath(n) {
  return `M${f(n.x)} ${f(n.y)}L${f(n.x + n.w)} ${f(n.y)}`;
}

/** Arrow head drawn at the end of a line, scaled with stroke weight. */
export function arrowHeadPath(n) {
  const s = Math.max(6, (n.strokeWidth || 1) * 4);
  const ex = n.x + n.w, ey = n.y;
  return `M${f(ex - s)} ${f(ey - s * 0.6)}L${f(ex)} ${f(ey)}L${f(ex - s)} ${f(ey + s * 0.6)}`;
}

export function pathFor(n) {
  switch (n.type) {
    case 'ellipse':
      return ellipsePath(n.x, n.y, n.w, n.h);
    case 'polygon':
    case 'star': {
      const p = polyPoints(n);
      return 'M' + p.map((q) => `${f(q.x)} ${f(q.y)}`).join('L') + 'Z';
    }
    case 'line':
    case 'arrow':
      return linePath(n);
    case 'vector':
      return vectorPath(n.points || [], n.closed, n.x, n.y);
    default:
      return rectPath(n.x, n.y, n.w, n.h, cornerRadii(n));
  }
}

export const hasRadius = (n) => ['rect', 'frame', 'image', 'section'].includes(n.type);
