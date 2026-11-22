import { gradientStops } from '../core/gradient.js';
// CSS for a layer, for the Inspect tab (developer hand-off).

import { cornerRadii } from '../core/paths.js';
import { fontStack, lineHeightPx, hexA } from '../render/text.js';

const px = (v) => `${Math.round(v * 100) / 100}px`;

export function cssFor(store, n) {
  const out = [];
  const add = (k, v) => out.push(`${k}: ${v};`);
  const parent = store.parent(n.id);
  if (parent && parent.layout && !n.absolute) {
    if (n.sizing?.h === 'fill') add(parent.layout.mode === 'horizontal' ? 'flex' : 'align-self', parent.layout.mode === 'horizontal' ? (parent.layout.wrap ? '0 0 100%' : '1 0 0') : 'stretch');
  } else if (parent) {
    add('position', 'absolute');
    add('left', px(n.x - parent.x));
    add('top', px(n.y - parent.y));
  }
  if (n.type === 'text') {
    if (n.text.autoResize !== 'width') add('width', px(n.w));
    if (n.text.autoResize === 'fixed') add('height', px(n.h));
  } else {
    if (n.sizing?.h !== 'hug' && n.sizing?.h !== 'fill') add('width', px(n.w));
    if (n.sizing?.v !== 'hug' && n.sizing?.v !== 'fill') add('height', px(n.h || 0));
  }
  if (n.rotation) add('transform', `rotate(${-n.rotation}deg)`);
  if (n.layout) {
    const L = n.layout;
    add('display', 'flex');
    add('flex-direction', L.mode === 'horizontal' ? 'row' : 'column');
    const map = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
    add('justify-content', map[L.primary]);
    add('align-items', map[L.counter]);
    if (L.mode === 'horizontal' && L.wrap && n.sizing?.h !== 'hug') {
      add('flex-wrap', 'wrap');
      add('align-content', 'flex-start');
      add('row-gap', px(L.rowGap ?? L.gap));
      if (L.primary !== 'space-between') add('column-gap', px(L.gap));
    } else if (L.primary !== 'space-between') add('gap', px(L.gap));
    const p = L.padding;
    add('padding', `${px(p.t)} ${px(p.r)} ${px(p.b)} ${px(p.l)}`);
  }
  const fills = (n.fills || []).filter((f) => f.visible !== false);
  if (n.type === 'text') {
    const t = n.text;
    const f = fills.find((x) => x.type === 'solid');
    if (f) add('color', hexA(f.color, f.opacity));
    add('font-family', fontStack(t.fontFamily));
    add('font-size', px(t.fontSize));
    add('font-weight', t.fontWeight);
    if (t.italic) add('font-style', 'italic');
    add('line-height', t.lineHeight ? px(t.lineHeight) : 'normal');
    if (t.letterSpacing) add('letter-spacing', `${t.letterSpacing / 100}em`);
    if (t.align !== 'left') add('text-align', t.align);
    const deco = [t.underline && 'underline', t.strike && 'line-through'].filter(Boolean).join(' ');
    if (deco) add('text-decoration', deco);
    const tcase = { upper: 'uppercase', lower: 'lowercase', title: 'capitalize' }[t.textCase];
    if (tcase) add('text-transform', tcase);
  } else if (fills.length) {
    const bg = fills.map((f) => {
      if (f.type === 'image') return `url(image.png) center / ${f.fit === 'fit' ? 'contain' : f.fit === 'stretch' ? '100% 100%' : 'cover'} no-repeat`;
      if (f.type === 'linear' || f.type === 'radial') {
        const stops = gradientStops(f).map((s) => `${hexA(s.color, s.opacity * (f.opacity ?? 1))} ${Math.round(s.position * 10000) / 100}%`);
        return f.type === 'linear' ? `linear-gradient(${f.angle}deg, ${stops.join(', ')})` : `radial-gradient(ellipse farthest-corner, ${stops.join(', ')})`;
      }
      return `linear-gradient(${hexA(f.color, f.opacity)}, ${hexA(f.color, f.opacity)})`;
    });
    if (fills.length === 1 && fills[0].type === 'solid') add('background', hexA(fills[0].color, fills[0].opacity));
    else add('background', bg.join(', '));
  }
  const strokes = (n.strokes || []).filter((s) => s.visible !== false);
  if (strokes.length && n.strokeWidth && n.type !== 'text') {
    const s = strokes[0];
    const style = n.dashes ? (n.dashes.startsWith('1') ? 'dotted' : 'dashed') : 'solid';
    if (n.strokeAlign === 'inside' && !n.dashes) add('box-shadow', `inset 0 0 0 ${px(n.strokeWidth)} ${hexA(s.color, s.opacity)}`);
    else add('border', `${px(n.strokeWidth)} ${style} ${hexA(s.color, s.opacity)}`);
  }
  if (['rect', 'frame', 'image', 'section'].includes(n.type)) {
    const r = cornerRadii(n);
    if (r.some(Boolean)) add('border-radius', r.every((v) => v === r[0]) ? px(r[0]) : r.map(px).join(' '));
  }
  if (n.type === 'ellipse') add('border-radius', '50%');
  const shadows = (n.effects || []).filter((e) => e.visible !== false && e.type.includes('shadow'));
  if (shadows.length) add('box-shadow', shadows.map((e) => `${e.type === 'inner-shadow' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread || 0)} ${hexA(e.color, e.opacity)}`).join(', '));
  const blur = (n.effects || []).find((e) => e.visible !== false && e.type === 'layer-blur');
  if (blur) add('filter', `blur(${px(blur.blur / 2)})`);
  if (n.opacity < 1) add('opacity', Math.round(n.opacity * 100) / 100);
  if (n.type === 'frame' && n.clip) add('overflow', 'hidden');
  return `/* ${n.name} */\n` + out.join('\n');
}
