// Renders the document to SVG markup. Pure string building so it can also export.

import * as G from '../core/geometry.js';
import { pathFor, rectPath, cornerRadii, arrowHeadPath } from '../core/paths.js';
import { gradientStops } from '../core/gradient.js';
import { textCSS, escapeHTML, hexA } from './text.js';

const urlCache = new Map();
export function assetURL(store, id) {
  if (!id) return null;
  const data = store.assets[id];
  if (typeof data !== 'string' || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(data)) return null;
  let u = urlCache.get(data);
  if (u) return u;
  try {
    const [head, body] = data.split(',');
    const mime = /data:([^;]+)/.exec(head)[1];
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u = URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    u = data;
  }
  urlCache.set(data, u);
  return u;
}

const attr = (v) => escapeHTML(v);

export function renderNodes(store, ids, { exporting = false } = {}) {
  const defs = [];
  const body = ids.map((id) => nodeSVG(store, store.get(id), defs, exporting)).join('');
  return { defs: defs.join(''), body };
}

function paintAttr(store, n, paint, defs, i) {
  if (paint.type === 'linear' || paint.type === 'radial') {
    const id = `gradient-${attr(n.id)}-${i}`;
    const stops = gradientStops(paint).map((stop) =>
      `<stop offset="${stop.position}" stop-color="${stop.color}" stop-opacity="${stop.opacity}"/>`).join('');
    if (paint.type === 'linear') {
      const angle = (Number.isFinite(paint.angle) ? paint.angle : 90) * Math.PI / 180;
      const dx = Math.sin(angle), dy = -Math.cos(angle);
      const half = (n.w * Math.abs(dx) + n.h * Math.abs(dy)) / 2;
      const x = n.x + n.w / 2, y = n.y + n.h / 2;
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x - dx * half}" y1="${y - dy * half}" x2="${x + dx * half}" y2="${y + dy * half}">${stops}</linearGradient>`);
    } else {
      defs.push(`<radialGradient id="${id}" r="70.710678%">${stops}</radialGradient>`);
    }
    return `fill="url(#${id})" fill-opacity="${attr(paint.opacity ?? 1)}"`;
  }
  if (paint.type === 'image') {
    const id = `img-${attr(n.id)}-${i}`;
    const href = assetURL(store, paint.asset);
    const par = { fill: 'xMidYMid slice', fit: 'xMidYMid meet', stretch: 'none' }[paint.fit] || 'xMidYMid slice';
    const w = Math.max(0.01, n.w), h = Math.max(0.01, n.h);
    const inner = href
      ? `<image href="${attr(href)}" x="0" y="0" width="${attr(w)}" height="${attr(h)}" preserveAspectRatio="${attr(par)}"/>`
      : `<rect x="0" y="0" width="${attr(w)}" height="${attr(h)}" fill="#E4E4E7"/><path d="M0 0L${attr(w)} ${attr(h)}M${attr(w)} 0L0 ${attr(h)}" stroke="#A1A1AA" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${attr(n.x)}" y="${attr(n.y)}" width="${attr(w)}" height="${attr(h)}">${inner}</pattern>`);
    return `fill="url(#${id})" fill-opacity="${attr(paint.opacity ?? 1)}"`;
  }
  return `fill="${attr(paint.color)}" fill-opacity="${attr(paint.opacity ?? 1)}"`;
}

function fillsSVG(store, n, d, defs) {
  const fills = (n.fills || []).filter((f) => f.visible !== false);
  // fills are stored top-first like the panel; paint bottom-first
  return fills.slice().reverse().map((f, i) => `<path d="${attr(d)}" ${paintAttr(store, n, f, defs, i)}/>`).join('');
}

function strokesSVG(n, d, defs) {
  const strokes = (n.strokes || []).filter((s) => s.visible !== false);
  if (!strokes.length || !n.strokeWidth) return '';
  const open = n.type === 'line' || n.type === 'arrow' || (n.type === 'vector' && !n.closed);
  const align = open ? 'center' : n.strokeAlign || 'inside';
  const w = n.strokeWidth;
  const cap = open ? (n.strokeLinecap || 'round') : 'butt';
  const dash = n.dashes ? ` stroke-dasharray="${attr(n.dashes)}"` : '';
  let out = '';
  for (const s of strokes.slice().reverse()) {
    const col = `stroke="${attr(s.color)}" stroke-opacity="${attr(s.opacity ?? 1)}"`;
    if (align === 'center') {
      out += `<path d="${attr(d)}" fill="none" ${col} stroke-width="${attr(w)}" stroke-linecap="${attr(cap)}" stroke-linejoin="round"${dash}/>`;
      if (n.type === 'arrow' || n.strokeCap === 'arrow') out += `<path d="${attr(arrowHeadPath(n))}" fill="none" ${col} stroke-width="${attr(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (align === 'inside') {
      const cid = `sclip-${attr(n.id)}`;
      if (!defs.some((s) => s.startsWith(`<clipPath id="${cid}"`))) defs.push(`<clipPath id="${cid}"><path d="${attr(d)}"/></clipPath>`);
      out += `<path d="${attr(d)}" fill="none" ${col} stroke-width="${w * 2}" clip-path="url(#${cid})"${dash}/>`;
    } else {
      const mid = `smask-${attr(n.id)}`;
      const m = w * 2 + 4;
      defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${n.x - m}" y="${n.y - m}" width="${attr(n.w + m * 2)}" height="${attr(n.h + m * 2)}"><rect x="${n.x - m}" y="${n.y - m}" width="${attr(n.w + m * 2)}" height="${attr(n.h + m * 2)}" fill="#fff"/><path d="${attr(d)}" fill="#000"/></mask>`);
      out += `<path d="${attr(d)}" fill="none" ${col} stroke-width="${w * 2}" mask="url(#${mid})"${dash}/>`;
    }
  }
  return out;
}

function filterFor(n, defs) {
  const fx = (n.effects || []).filter((e) => e.visible !== false);
  if (!fx.length) return '';
  const id = `fx-${attr(n.id)}`;
  let margin = 20;
  for (const e of fx) margin = Math.max(margin, (e.blur || 0) * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0) + 20);
  const parts = [];
  const drops = [], inners = [];
  fx.forEach((e, i) => {
    if (e.type === 'drop-shadow') {
      const src = e.spread ? `sp${i}` : 'SourceAlpha';
      if (e.spread > 0) parts.push(`<feMorphology in="SourceAlpha" operator="dilate" radius="${attr(e.spread)}" result="sp${i}"/>`);
      if (e.spread < 0) parts.push(`<feMorphology in="SourceAlpha" operator="erode" radius="${-e.spread}" result="sp${i}"/>`);
      parts.push(`<feGaussianBlur in="${src}" stdDeviation="${(e.blur || 0) / 2}"/><feOffset dx="${attr(e.x)}" dy="${attr(e.y)}" result="o${i}"/><feFlood flood-color="${attr(e.color)}" flood-opacity="${attr(e.opacity ?? 0.25)}"/><feComposite in2="o${i}" operator="in" result="d${i}"/>`);
      drops.push(`d${i}`);
    } else if (e.type === 'inner-shadow') {
      parts.push(`<feComponentTransfer in="SourceAlpha" result="ia${i}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer><feOffset dx="${attr(e.x)}" dy="${attr(e.y)}"/><feGaussianBlur stdDeviation="${(e.blur || 0) / 2}" result="ib${i}"/><feFlood flood-color="${attr(e.color)}" flood-opacity="${attr(e.opacity ?? 0.25)}"/><feComposite in2="ib${i}" operator="in"/><feComposite in2="SourceAlpha" operator="in" result="in${i}"/>`);
      inners.push(`in${i}`);
    }
  });
  parts.push(`<feMerge result="m">${drops.map((d) => `<feMergeNode in="${attr(d)}"/>`).join('')}<feMergeNode in="SourceGraphic"/>${inners.map((d) => `<feMergeNode in="${attr(d)}"/>`).join('')}</feMerge>`);
  const blur = fx.find((e) => e.type === 'layer-blur');
  if (blur) parts.push(`<feGaussianBlur in="m" stdDeviation="${(blur.blur || 0) / 2}"/>`);
  defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${n.x - margin}" y="${n.y - margin}" width="${attr(n.w + margin * 2)}" height="${attr(n.h + margin * 2)}" color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
  return ` filter="url(#${id})"`;
}

export function nodeSVG(store, n, defs, exporting = false) {
  if (!n || !n.visible) return '';
  const m = store.localMatrix(n);
  const tf = m === G.IDENTITY ? '' : ` transform="${G.toSVG(m)}"`;
  const op = n.opacity < 1 ? ` opacity="${attr(n.opacity)}"` : '';
  const filter = filterFor(n, defs);
  let inner = '';
  const kids = () => (n.children || []).map((c) => nodeSVG(store, store.get(c), defs, exporting)).join('');

  switch (n.type) {
    case 'group':
      inner = kids();
      break;
    case 'frame':
    case 'section': {
      const d = rectPath(n.x, n.y, n.w, n.h, cornerRadii(n));
      inner += fillsSVG(store, n, d, defs);
      if (n.clip) {
        const cid = `clip-${attr(n.id)}`;
        defs.push(`<clipPath id="${cid}"><path d="${attr(d)}"/></clipPath>`);
        inner += `<g clip-path="url(#${cid})">${kids()}</g>`;
      } else inner += kids();
      inner += strokesSVG(n, d, defs);
      break;
    }
    case 'text': {
      const hidden = !exporting && store.editingText === n.id ? 'visibility:hidden;' : '';
      const va = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[n.text.valign] || 'flex-start';
      const content = escapeHTML(n.text.content || '');
      inner = `<foreignObject x="${attr(n.x)}" y="${attr(n.y)}" width="${Math.max(1, n.w)}" height="${Math.max(1, n.h)}" style="overflow:visible"><div xmlns="http://www.w3.org/1999/xhtml" style="${hidden}width:${Math.max(1, n.w)}px;height:${Math.max(1, n.h)}px;display:flex;flex-direction:column;justify-content:${attr(va)}"><div style="${attr(textCSS(n))}">${content}</div></div></foreignObject>`;
      break;
    }
    case 'code': {
      // The live render sits in the code layer above the scene; the scene keeps a box for exports and hit areas.
      const label = escapeHTML(n.code?.title || n.name);
      inner = exporting
        ? `<rect x="${attr(n.x)}" y="${attr(n.y)}" width="${attr(n.w)}" height="${attr(n.h)}" fill="#F4F4F5" stroke="#D4D4D8"/><text x="${n.x + 8}" y="${n.y + 18}" font-size="12" font-family="Inter, sans-serif" fill="#52525B">${label}</text>`
        : `<rect x="${attr(n.x)}" y="${attr(n.y)}" width="${Math.max(1, n.w)}" height="${Math.max(1, n.h)}" fill="transparent"/>`;
      break;
    }
    default: {
      const d = pathFor(n);
      const open = n.type === 'line' || n.type === 'arrow' || (n.type === 'vector' && !n.closed);
      inner = (open && n.type !== 'vector' ? '' : fillsSVG(store, n, d, defs)) + strokesSVG(n, d, defs);
      if (open && !(n.strokes || []).some((s) => s.visible !== false)) {
        inner += `<path d="${attr(d)}" fill="none" stroke="transparent" stroke-width="1"/>`;
      }
    }
  }
  return `<g data-id="${attr(n.id)}"${tf}${op}${filter}>${inner}</g>`;
}

/** Standalone SVG for export (selection or whole page). */
export function exportSVG(store, ids) {
  const box = store.selectionBox(ids);
  if (!box) return '';
  const defs = [];
  const body = ids.map((id) => {
    const markup = nodeSVG(store, store.get(id), defs, true);
    const parent = store.parentMatrix(id);
    return parent === G.IDENTITY ? markup : `<g transform="${G.toSVG(parent)}">${markup}</g>`;
  }).join('');
  const embedded = body.replace(/href="(blob:[^"]+)"/g, (m, u) => {
    for (const [data, url] of urlCache) if (url === u) return `href="${attr(data)}"`;
    return m;
  });
  const embeddedDefs = defs.join('').replace(/href="(blob:[^"]+)"/g, (m, u) => {
    for (const [data, url] of urlCache) if (url === u) return `href="${attr(data)}"`;
    return m;
  });
  const w = Math.max(1, box.w), h = Math.max(1, box.h);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${box.x} ${box.y} ${w} ${h}"><defs>${embeddedDefs}</defs>${embedded}</svg>`;
}

export { hexA };
