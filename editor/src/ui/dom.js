// Tiny DOM helpers and a popup menu used by the toolbar, context menu and panels.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';
export const ALT = IS_MAC ? '⌥' : 'Alt+';
export const SHIFT = IS_MAC ? '⇧' : 'Shift+';

/** Formats "Shift Mod K" style shortcut strings for the platform. */
export function keyLabel(k) {
  if (!k) return '';
  return k.split(' ').map((p) => ({ Shift: SHIFT, Mod: MOD, '⌘': MOD, Alt: ALT })[p] ?? p).join('');
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

/**
 * Shows a menu at a screen point. items: { label, icon?, shortcut?, action?, disabled?, checked? } or '-' for a divider.
 */
export function showMenu(items, x, y, { className = '', anchor = null } = {}) {
  closeMenu();
  const menu = h('div', { class: 'dz-menu ' + className, role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'dz-menu-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'dz-menu-header' }, it.header)); continue; }
    const row = h('button', {
      class: 'dz-menu-item' + (it.checked ? ' checked' : ''),
      role: 'menuitem',
      disabled: it.disabled,
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); },
    },
    h('span', { class: 'dz-menu-check', html: it.checked ? '✓' : '' }),
    it.icon ? h('span', { class: 'dz-menu-icon', html: it.icon }) : null,
    h('span', { class: 'dz-menu-label' }, it.label),
    h('span', { class: 'dz-menu-key' }, keyLabel(it.shortcut || '')));
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (anchor === 'above') top = y - r.height - 8;
  if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
  if (left < 8) left = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  openMenu = menu;
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  }, 0);
  return menu;
}

export function toast(text) {
  const t = h('div', { class: 'dz-toast' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 1800);
  setTimeout(() => t.remove(), 2200);
}

export function download(name, content, type = 'image/svg+xml') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
