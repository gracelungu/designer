// Text styling shared by the renderer, the measurer and the inline text editor.

export function textColor(n) {
  const f = (n.fills || []).find((x) => x.visible !== false && x.type === 'solid');
  if (!f) return 'transparent';
  return hexA(f.color, (f.opacity ?? 1));
}

export function hexA(hex, a = 1) {
  if (a >= 1) return hex;
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

const FALLBACK = {
  Inter: 'Inter, system-ui, sans-serif',
  Roboto: 'Roboto, Arial, sans-serif',
  'JetBrains Mono': '"JetBrains Mono", ui-monospace, monospace',
  'Courier New': '"Courier New", monospace',
  Georgia: 'Georgia, serif',
  'Times New Roman': '"Times New Roman", serif',
};

export function fontStack(family) {
  return FALLBACK[family] || `"${family}", system-ui, sans-serif`;
}

export function lineHeightPx(t) {
  return t.lineHeight ? t.lineHeight : Math.round(t.fontSize * 1.21 * 100) / 100;
}

/** CSS for a text node's content box. */
export function textCSS(n, { color = true } = {}) {
  const t = n.text;
  const deco = [t.underline && 'underline', t.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
  const wrap = t.autoResize === 'width' ? 'pre' : 'pre-wrap';
  const tcase = { upper: 'uppercase', lower: 'lowercase', title: 'capitalize' }[t.textCase] || 'none';
  return [
    `font-family:${fontStack(t.fontFamily)}`,
    `font-size:${t.fontSize}px`,
    `font-weight:${t.fontWeight}`,
    `font-style:${t.italic ? 'italic' : 'normal'}`,
    `line-height:${lineHeightPx(t)}px`,
    `letter-spacing:${(t.letterSpacing || 0) / 100}em`,
    `text-align:${t.align}`,
    `text-decoration:${deco}`,
    `text-transform:${tcase}`,
    `white-space:${wrap}`,
    'overflow-wrap:break-word',
    'margin:0',
    'padding:0',
    color ? `color:${textColor(n)}` : '',
  ].filter(Boolean).join(';');
}

let measurer = null;
/** Measures a text node. width=null means auto width. */
export function measureText(n, width) {
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(measurer);
  }
  measurer.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;${textCSS(n)};${width == null ? 'width:auto' : `width:${width}px`}`;
  const content = n.text.content || '';
  measurer.textContent = content.endsWith('\n') || !content ? content + '​' : content;
  const r = measurer.getBoundingClientRect();
  const lh = lineHeightPx(n.text);
  return { w: Math.ceil(r.width * 100) / 100 || 1, h: Math.max(lh, Math.round(r.height * 100) / 100) };
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
