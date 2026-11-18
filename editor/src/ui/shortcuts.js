// Figma-style keyboard shortcuts, clipboard and the context menu.

import * as C from '../core/commands.js';
import { showMenu, closeMenu, toast } from './dom.js';
import { hitTest } from '../core/hittest.js';
import { pickTarget } from '../tools/select.js';

// Keys typed in fields, or anywhere inside an element marked data-canvas-keys="off" (a host app's chat, say), stay there.
const isTyping = (t) => t && (t.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [data-canvas-keys="off"]'));
const hasTextSelection = () => { try { return !!String(window.getSelection() || '').trim(); } catch { return false; } };

export const SHORTCUTS = [
  ['Tools', [
    ['Move', 'V'], ['Scale', 'K'], ['Hand (or hold Space)', 'H'], ['Frame', 'F'], ['Section', 'Shift S'],
    ['Rectangle', 'R'], ['Ellipse', 'O'], ['Line', 'L'], ['Arrow', 'Shift L'], ['Pen', 'P'], ['Pencil', 'Shift P'],
    ['Text', 'T'], ['Comment', 'C'], ['Place image', 'Shift Mod K'], ['Show comments', 'Shift C'],
  ]],
  ['Edit', [
    ['Undo', 'Mod Z'], ['Redo', 'Shift Mod Z'], ['Copy', 'Mod C'], ['Cut', 'Mod X'], ['Paste', 'Mod V'],
    ['Duplicate', 'Mod D'], ['Duplicate while dragging', 'Alt drag'], ['Delete', 'Delete'], ['Rename', 'Mod R'],
    ['Copy properties', 'Alt Mod C'], ['Paste properties', 'Alt Mod V'], ['Opacity 10%…100%', '1…0'],
  ]],
  ['Selection', [
    ['Select all', 'Mod A'], ['Select deepest layer', 'Mod click'], ['Add to selection', 'Shift click'],
    ['Select children', 'Enter'], ['Select parent', 'Shift Enter'], ['Next / previous layer', 'Tab'],
    ['Deselect / exit', 'Esc'], ['Measure distances', 'Alt hover'],
  ]],
  ['Arrange', [
    ['Group', 'Mod G'], ['Ungroup', 'Shift Mod G'], ['Frame selection', 'Alt Mod G'], ['Add auto layout', 'Shift A'],
    ['Remove auto layout', 'Alt Shift A'], ['Bring forward', 'Mod ]'], ['Send backward', 'Mod ['], ['Bring to front', ']'], ['Send to back', '['],
    ['Align left / right', 'Alt A / Alt D'], ['Align top / bottom', 'Alt W / Alt S'], ['Align centers', 'Alt H / Alt V'],
    ['Distribute', 'Alt Shift H / V'], ['Tidy up', 'Ctrl Alt T'], ['Flip horizontal / vertical', 'Shift H / Shift V'],
    ['Show / hide', 'Shift Mod H'], ['Lock / unlock', 'Shift Mod L'], ['Nudge', 'Arrows (Shift for 10)'],
  ]],
  ['View', [
    ['Zoom in / out', 'Mod + / Mod -'], ['Zoom to 100%', 'Shift 0'], ['Zoom to fit', 'Shift 1'], ['Zoom to selection', 'Shift 2'],
    ['Zoom with the wheel', 'Mod scroll'], ['Pan', 'Space drag'],
  ]],
  ['While drawing or resizing', [
    ['Keep proportions / 45°', 'Shift'], ['From the center', 'Alt'], ['Ignore snapping', 'Mod'], ['Rotate in 15° steps', 'Shift'],
  ]],
  ['Text', [['Bold / italic / underline', 'Mod B / I / U'], ['Finish editing', 'Esc']]],
];

export function bindShortcuts(editor, { layers, onShortcuts, onAskAI } = {}) {
  const store = editor.store;
  let clipboard = null;

  const viewportRect = () => editor.viewRect();
  const offs = [];
  const listen = (target, type, fn) => { target.addEventListener(type, fn); offs.push(() => target.removeEventListener(type, fn)); };

  listen(window, 'keydown', (e) => {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const code = e.code;
    const tool = editor.tool;

    if (k === ' ' || code === 'Space') {
      if (!editor.keys.space) { editor.keys.space = true; editor.updateCursor(); }
      e.preventDefault();
      return;
    }
    editor.keys.alt = e.altKey;
    if (e.key === 'Alt') { store.emit('overlay'); }
    if (tool.onKey && tool.onKey(e)) { e.preventDefault(); return; }

    const run = (fn) => { e.preventDefault(); closeMenu(); fn(); };

    // ---- with Cmd/Ctrl ----
    if (mod) {
      if (k === 'z' && !e.shiftKey) return run(() => store.undo());
      if ((k === 'z' && e.shiftKey) || k === 'y') return run(() => store.redo());
      if (k === 'd') return run(() => C.duplicate(store));
      if (k === 'a' && !e.shiftKey) return run(() => C.selectAll(store));
      if (k === 'g' && e.altKey) return run(() => C.frameSelection(store));
      if (code === 'KeyG' && e.altKey) return run(() => C.frameSelection(store));
      if (k === 'g' && e.shiftKey) return run(() => C.ungroup(store));
      if (k === 'g') return run(() => C.group(store));
      if (code === 'BracketRight') return run(() => C.reorder(store, e.altKey ? 'front' : 'forward'));
      if (code === 'BracketLeft') return run(() => C.reorder(store, e.altKey ? 'back' : 'backward'));
      if (code === 'KeyH' && e.shiftKey) return run(() => C.toggle(store, 'visible'));
      if (code === 'KeyL' && e.shiftKey) return run(() => C.toggle(store, 'locked'));
      if (code === 'KeyK' && e.shiftKey) return run(() => editor.pickImages());
      if (code === 'KeyC' && e.altKey) return run(() => { C.copyProperties(store); toast('Properties copied'); });
      if (code === 'KeyV' && e.altKey) return run(() => C.pasteProperties(store));
      if (k === 'r') return run(() => layers && layers.renameSelected());
      if (k === '=' || k === '+') return run(() => editor.zoomStep(1));
      if (k === '-' || k === '_') return run(() => editor.zoomStep(-1));
      if (k === '0') return run(() => editor.zoomAt(1));
      if (k === 's') return run(() => toast('Saved in this browser'));
      if (code === 'KeyT' && e.altKey && e.ctrlKey) return run(() => C.tidyUp(store));
      if (['b', 'i', 'u'].includes(k)) {
        const texts = store.selected().filter((n) => n.type === 'text');
        if (texts.length) return run(() => store.transact(() => texts.forEach((n) => {
          if (k === 'b') n.text.fontWeight = n.text.fontWeight >= 600 ? 400 : 700;
          if (k === 'i') n.text.italic = !n.text.italic;
          if (k === 'u') n.text.underline = !n.text.underline;
        })));
      }
      if (code === 'Slash' && e.shiftKey) return run(() => onShortcuts && onShortcuts());
      return;
    }

    // ---- with Alt ----
    if (e.altKey) {
      const map = { KeyA: 'left', KeyD: 'right', KeyH: 'hcenter', KeyW: 'top', KeyS: 'bottom', KeyV: 'vcenter' };
      if (e.shiftKey && code === 'KeyH') return run(() => C.distribute(store, 'h'));
      if (e.shiftKey && code === 'KeyV') return run(() => C.distribute(store, 'v'));
      if (e.shiftKey && code === 'KeyA') return run(() => C.removeAutoLayout(store));
      if (map[code]) return run(() => C.align(store, map[code]));
    }

    // ---- plain keys ----
    if (e.key === 'Escape') {
      return run(() => {
        if (editor.code && editor.code.interacting) { editor.code.interact(null); return; }
        if (store.overlay.editingPath) { editor.tools.move.exitPathEdit(); return; }
        if (store.tool !== 'move') { editor.setTool('move'); return; }
        const parents = [...new Set(store.selected().map((n) => n.parent).filter(Boolean))];
        if (parents.length) store.select(parents);
        else store.select([]);
      });
    }
    if (e.key === 'Enter') {
      return run(() => {
        const sel = store.selected();
        if (e.shiftKey) { C.selectParent(store); return; }
        if (sel.length === 1 && sel[0].type === 'text') { editor.textEditor.start(sel[0].id); return; }
        if (sel.length === 1 && sel[0].type === 'vector') { editor.tools.move.enterPathEdit(sel[0].id); return; }
        C.selectChildren(store);
      });
    }
    if (e.key === 'Tab') return run(() => C.selectSibling(store, e.shiftKey ? -1 : 1));
    if (e.key === 'Backspace' || e.key === 'Delete') return run(() => C.deleteSelection(store));
    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      return run(() => C.nudge(store, d[0], d[1]));
    }
    if (e.shiftKey) {
      if (code === 'Digit0') return run(() => editor.zoomAt(1));
      if (code === 'Digit1') return run(() => editor.zoomToFit());
      if (code === 'Digit2') return run(() => editor.zoomToSelection());
      if (code === 'KeyA') return run(() => C.addAutoLayout(store));
      if (code === 'KeyS') return run(() => editor.setTool('section'));
      if (code === 'KeyL') return run(() => editor.setTool('arrow'));
      if (code === 'KeyP') return run(() => editor.setTool('pencil'));
      if (code === 'KeyH') return run(() => C.flip(store, 'x'));
      if (code === 'KeyV') return run(() => C.flip(store, 'y'));
      if (code === 'KeyC') return run(() => { editor.comments.showAlways = !editor.comments.showAlways; editor.comments.render(); toast(editor.comments.showAlways ? 'Showing comments' : 'Comments hidden outside comment mode'); });
      if (code === 'Slash') return run(() => onShortcuts && onShortcuts());
      if (code === 'Enter') return;
      return;
    }
    const tools = { v: 'move', k: 'scale', h: 'hand', f: 'frame', a: 'frame', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', t: 'text', c: 'comment' };
    if (tools[k]) return run(() => editor.setTool(tools[k]));
    if (code === 'BracketRight') return run(() => C.reorder(store, 'front'));
    if (code === 'BracketLeft') return run(() => C.reorder(store, 'back'));
    if (/^[0-9]$/.test(k) && store.selection.length) return run(() => C.setOpacity(store, k === '0' ? 1 : +k / 10));
    if (k === '/' && onAskAI) return run(() => onAskAI());
  });

  listen(window, 'keyup', (e) => {
    if (e.key === ' ' || e.code === 'Space') { editor.keys.space = false; editor.updateCursor(); }
    if (e.key === 'Alt') { editor.keys.alt = false; store.emit('overlay'); }
  });
  listen(window, 'blur', () => { editor.keys.space = false; editor.keys.alt = false; });

  // ---- clipboard ----
  listen(document, 'copy', (e) => {
    if (isTyping(e.target) || isTyping(document.activeElement) || hasTextSelection() || !store.selection.length) return;
    clipboard = C.copy(store);
    e.clipboardData.setData('text/plain', JSON.stringify(clipboard));
    e.preventDefault();
  });
  listen(document, 'cut', (e) => {
    if (isTyping(e.target) || isTyping(document.activeElement) || hasTextSelection() || !store.selection.length) return;
    clipboard = C.copy(store);
    e.clipboardData.setData('text/plain', JSON.stringify(clipboard));
    e.preventDefault();
    C.deleteSelection(store);
  });
  listen(document, 'paste', (e) => {
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    e.preventDefault();
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { editor.insertImages(files); return; }
    const text = e.clipboardData?.getData('text/plain') || '';
    let payload = null;
    try { const p = JSON.parse(text); if (p && p.kind === 'designer/nodes') payload = p; } catch { /* not ours */ }
    if (!payload && !text && clipboard) payload = clipboard;
    if (payload) { C.paste(store, payload, { viewportRect: viewportRect() }); return; }
    if (text.trim()) {
      const vr = viewportRect();
      store.transact(() => {
        const n = store.create('text', { x: Math.round(vr.x + vr.w / 2 - 50), y: Math.round(vr.y + vr.h / 2 - 10), name: text.slice(0, 40) });
        n.text.content = text;
        store.selection = [n.id];
      });
      store.emit('selection');
    }
  });

  // ---- context menu ----
  editor.root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = editor.toWorld(e.clientX, e.clientY);
    const chain = hitTest(store, p, 4 / store.view.zoom);
    const target = pickTarget(store, chain, e.metaKey || e.ctrlKey);
    if (target && !store.selection.includes(target)) store.select([target]);
    const has = store.selection.length > 0;
    const sel = store.selected();
    const items = [
      { label: 'Copy', shortcut: 'Mod C', disabled: !has, action: () => { clipboard = C.copy(store); try { navigator.clipboard.writeText(JSON.stringify(clipboard)); } catch { /* blocked */ } } },
      { label: 'Paste here', shortcut: '', disabled: !clipboard, action: () => {
        const ids = C.paste(store, clipboard, { viewportRect: viewportRect(), intoSelection: false });
        const b = store.selectionBox(ids);
        if (b) store.transact(() => ids.forEach((id) => store.moveBy(id, Math.round(p.x - b.x), Math.round(p.y - b.y))));
      } },
      { label: 'Duplicate', shortcut: 'Mod D', disabled: !has, action: () => C.duplicate(store) },
      { label: 'Delete', shortcut: 'Delete', disabled: !has, action: () => C.deleteSelection(store) },
      '-',
      { label: 'Bring to front', shortcut: ']', disabled: !has, action: () => C.reorder(store, 'front') },
      { label: 'Bring forward', shortcut: 'Mod ]', disabled: !has, action: () => C.reorder(store, 'forward') },
      { label: 'Send backward', shortcut: 'Mod [', disabled: !has, action: () => C.reorder(store, 'backward') },
      { label: 'Send to back', shortcut: '[', disabled: !has, action: () => C.reorder(store, 'back') },
      '-',
      { label: 'Group selection', shortcut: 'Mod G', disabled: !has, action: () => C.group(store) },
      { label: 'Frame selection', shortcut: 'Alt Mod G', disabled: !has, action: () => C.frameSelection(store) },
      { label: 'Ungroup', shortcut: 'Shift Mod G', disabled: !sel.some((n) => n.children), action: () => C.ungroup(store) },
      { label: 'Add auto layout', shortcut: 'Shift A', disabled: !has, action: () => C.addAutoLayout(store) },
      sel.some((n) => n.layout) ? { label: 'Remove auto layout', shortcut: 'Alt Shift A', action: () => C.removeAutoLayout(store) } : null,
      '-',
      { label: 'Flip horizontal', shortcut: 'Shift H', disabled: !has, action: () => C.flip(store, 'x') },
      { label: 'Flip vertical', shortcut: 'Shift V', disabled: !has, action: () => C.flip(store, 'y') },
      '-',
      { label: sel.length && sel.every((n) => !n.visible) ? 'Show' : 'Hide', shortcut: 'Shift Mod H', disabled: !has, action: () => C.toggle(store, 'visible') },
      { label: 'Lock', shortcut: 'Shift Mod L', disabled: !has, action: () => C.toggle(store, 'locked') },
      { label: 'Copy properties', shortcut: 'Alt Mod C', disabled: !has, action: () => C.copyProperties(store) },
      { label: 'Paste properties', shortcut: 'Alt Mod V', disabled: !has, action: () => C.pasteProperties(store) },
      '-',
      { label: 'Select all', shortcut: 'Mod A', action: () => C.selectAll(store) },
      { label: 'Zoom to selection', shortcut: 'Shift 2', disabled: !has, action: () => editor.zoomToSelection() },
    ].filter(Boolean);
    showMenu(items, e.clientX, e.clientY);
  });

  return { getClipboard: () => clipboard, unbind: () => offs.forEach((off) => off()) };
}
