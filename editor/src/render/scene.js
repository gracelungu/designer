// Renders the document to SVG markup. Pure string building so it can also export.

import * as G from '../core/geometry.js';
import { pathFor, rectPath, cornerRadii, arrowHeadPath } from '../core/paths.js';
import { textCSS, escapeHTML, hexA } from './text.js';

const urlCache = new Map();
export function assetURL(store, id) {
  if (!id) return null;
  const data = store.assets[id];
  if (!data) return null;
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
    const stops = (paint.stops ?? []).slice().sort((a, b) => a.offset - b.offset)
      .map((stop) => `<stop offset="${attr(stop.offset)}" stop-color="${attr(stop.color)}" stop-opacity="${attr(stop.opacity ?? 1)}"/>`).join('');
    if (paint.type === 'linear') {
      const angle = (Number(paint.angle) || 0) * Math.PI / 180;
      const dx = Math.cos(angle) / 2, dy = Math.sin(angle) / 2;
      defs.push(`<linearGradient id="${id}" x1="${0.5 - dx}" y1="${0.5 - dy}" x2="${0.5 + dx}" y2="${0.5 + dy}">${stops}</linearGradient>`);
    } else defs.push(`<radialGradient id="${id}">${stops}</radialGradient>`);
    return `fill="url(#${id})" fill-opacity="${attr(paint.opacity ?? 1)}"`;
  }
  if (paint.type === 'image') {
    const id = `img-${n.id}-${i}`;
    const href = assetURL(store, paint.asset);
    const par = { fill: 'xMidYMid slice', fit: 'xMidYMid meet', stretch: 'none' }[paint.fit] || 'xMidYMid slice';
    const w = Math.max(0.01, n.w), h = Math.max(0.01, n.h);
    const inner = href
      ? `<image href="${attr(href)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${par}"/>`
      : `<rect x="0" y="0" width="${w}" height="${h}" fill="#E4E4E7"/><path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="#A1A1AA" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n.x}" y="${n.y}" width="${w}" height="${h}">${inner}</pattern>`);
    return `fill="url(#${id})" fill-opacity="${paint.opacity ?? 1}"`;
  }
  return `fill="${paint.color}" fill-opacity="${paint.opacity ?? 1}"`;
}

function fillsSVG(store, n, d, defs) {
  const fills = (n.fills || []).filter((f) => f.visible !== false);
  // fills are stored top-first like the panel; paint bottom-first
  return fills.slice().reverse().map((f, i) => `<path d="${d}" ${paintAttr(store, n, f, defs, i)}/>`).join('');
}

function strokesSVG(n, d, defs) {
  const strokes = (n.strokes || []).filter((s) => s.visible !== false);
  if (!strokes.length || !n.strokeWidth) return '';
  const open = n.type === 'line' || n.type === 'arrow' || (n.type === 'vector' && !n.closed);
  const align = open ? 'center' : n.strokeAlign || 'inside';
  const w = n.strokeWidth;
  const cap = open ? (n.strokeLinecap || 'round') : 'butt';
  const dash = n.dashes ? ` stroke-dasharray="${n.dashes}"` : '';
  let out = '';
  for (const s of strokes.slice().reverse()) {
    const col = `stroke="${s.color}" stroke-opacity="${s.opacity ?? 1}"`;
    if (align === 'center') {
      out += `<path d="${d}" fill="none" ${col} stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="round"${dash}/>`;
      if (n.type === 'arrow' || n.strokeCap === 'arrow') out += `<path d="${arrowHeadPath(n)}" fill="none" ${col} stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (align === 'inside') {
      const cid = `sclip-${n.id}`;
      if (!defs.some((s) => s.startsWith(`<clipPath id="${cid}"`))) defs.push(`<clipPath id="${cid}"><path d="${d}"/></clipPath>`);
      out += `<path d="${d}" fill="none" ${col} stroke-width="${w * 2}" clip-path="url(#${cid})"${dash}/>`;
    } else {
      const mid = `smask-${n.id}`;
      const m = w * 2 + 4;
      defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${n.x - m}" y="${n.y - m}" width="${n.w + m * 2}" height="${n.h + m * 2}"><rect x="${n.x - m}" y="${n.y - m}" width="${n.w + m * 2}" height="${n.h + m * 2}" fill="#fff"/><path d="${d}" fill="#000"/></mask>`);
      out += `<path d="${d}" fill="none" ${col} stroke-width="${w * 2}" mask="url(#${mid})"${dash}/>`;
    }
  }
  return out;
}

function filterFor(n, defs) {
  const fx = (n.effects || []).filter((e) => e.visible !== false);
  if (!fx.length) return '';
  const id = `fx-${n.id}`;
  let margin = 20;
  for (const e of fx) margin = Math.max(margin, (e.blur || 0) * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0) + 20);
  const parts = [];
  const drops = [], inners = [];
  fx.forEach((e, i) => {
    if (e.type === 'drop-shadow') {
      const src = e.spread ? `sp${i}` : 'SourceAlpha';
      if (e.spread > 0) parts.push(`<feMorphology in="SourceAlpha" operator="dilate" radius="${e.spread}" result="sp${i}"/>`);
      if (e.spread < 0) parts.push(`<feMorphology in="SourceAlpha" operator="erode" radius="${-e.spread}" result="sp${i}"/>`);
      parts.push(`<feGaussianBlur in="${src}" stdDeviation="${(e.blur || 0) / 2}"/><feOffset dx="${e.x}" dy="${e.y}" result="o${i}"/><feFlood flood-color="${e.color}" flood-opacity="${e.opacity ?? 0.25}"/><feComposite in2="o${i}" operator="in" result="d${i}"/>`);
      drops.push(`d${i}`);
    } else if (e.type === 'inner-shadow') {
      parts.push(`<feComponentTransfer in="SourceAlpha" result="ia${i}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer><feOffset dx="${e.x}" dy="${e.y}"/><feGaussianBlur stdDeviation="${(e.blur || 0) / 2}" result="ib${i}"/><feFlood flood-color="${e.color}" flood-opacity="${e.opacity ?? 0.25}"/><feComposite in2="ib${i}" operator="in"/><feComposite in2="SourceAlpha" operator="in" result="in${i}"/>`);
      inners.push(`in${i}`);
    }
  });
  parts.push(`<feMerge result="m">${drops.map((d) => `<feMergeNode in="${d}"/>`).join('')}<feMergeNode in="SourceGraphic"/>${inners.map((d) => `<feMergeNode in="${d}"/>`).join('')}</feMerge>`);
  const blur = fx.find((e) => e.type === 'layer-blur');
  if (blur) parts.push(`<feGaussianBlur in="m" stdDeviation="${(blur.blur || 0) / 2}"/>`);
  defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${n.x - margin}" y="${n.y - margin}" width="${n.w + margin * 2}" height="${n.h + margin * 2}" color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
  return ` filter="url(#${id})"`;
}

export function nodeSVG(store, n, defs, exporting = false) {
  if (!n || !n.visible) return '';
  const m = store.localMatrix(n);
  const tf = m === G.IDENTITY ? '' : ` transform="${G.toSVG(m)}"`;
  const op = n.opacity < 1 ? ` opacity="${n.opacity}"` : '';
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
        const cid = `clip-${n.id}`;
        defs.push(`<clipPath id="${cid}"><path d="${d}"/></clipPath>`);
        inner += `<g clip-path="url(#${cid})">${kids()}</g>`;
      } else inner += kids();
      inner += strokesSVG(n, d, defs);
      break;
    }
    case 'text': {
      const hidden = !exporting && store.editingText === n.id ? 'visibility:hidden;' : '';
      const va = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[n.text.valign] || 'flex-start';
      const content = escapeHTML(n.text.content || '');
      inner = `<foreignObject x="${n.x}" y="${n.y}" width="${Math.max(1, n.w)}" height="${Math.max(1, n.h)}" style="overflow:visible"><div xmlns="http://www.w3.org/1999/xhtml" style="${hidden}width:${Math.max(1, n.w)}px;height:${Math.max(1, n.h)}px;display:flex;flex-direction:column;justify-content:${va}"><div style="${attr(textCSS(n))}">${content}</div></div></foreignObject>`;
      break;
    }
    case 'code': {
      // The live render sits in the code layer above the scene; the scene keeps a box for exports and hit areas.
      const label = escapeHTML(n.code?.title || n.name);
      inner = exporting
        ? `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="#F4F4F5" stroke="#D4D4D8"/><text x="${n.x + 8}" y="${n.y + 18}" font-size="12" font-family="Inter, sans-serif" fill="#52525B">${label}</text>`
        : `<rect x="${n.x}" y="${n.y}" width="${Math.max(1, n.w)}" height="${Math.max(1, n.h)}" fill="transparent"/>`;
      break;
    }
    default: {
      const d = pathFor(n);
      const open = n.type === 'line' || n.type === 'arrow' || (n.type === 'vector' && !n.closed);
      inner = (open && n.type !== 'vector' ? '' : fillsSVG(store, n, d, defs)) + strokesSVG(n, d, defs);
      if (open && !(n.strokes || []).some((s) => s.visible !== false)) {
        inner += `<path d="${d}" fill="none" stroke="transparent" stroke-width="1"/>`;
      }
    }
  }
  return `<g data-id="${n.id}"${tf}${op}${filter}>${inner}</g>`;
}

/** Standalone SVG for export (selection or whole page). */
export function exportSVG(store, ids) {
  const box = store.selectionBox(ids);
  if (!box) return '';
  const { defs, body } = renderNodes(store, ids, { exporting: true });
  const embedded = body.replace(/href="(blob:[^"]+)"/g, (m, u) => {
    for (const [data, url] of urlCache) if (url === u) return `href="${data}"`;
    return m;
  });
  const embeddedDefs = defs.replace(/href="(blob:[^"]+)"/g, (m, u) => {
    for (const [data, url] of urlCache) if (url === u) return `href="${data}"`;
    return m;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(box.w)}" height="${Math.ceil(box.h)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><defs>${embeddedDefs}</defs>${embedded}</svg>`;
}

export { hexA };
