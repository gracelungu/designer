// Standalone editor page: wires the canvas, toolbar, layers, properties, shortcuts and saving.

import { Editor } from './editor.js';
import { Toolbar } from './ui/toolbar.js';
import { LayersPanel } from './ui/layers.js';
import { PropertiesPanel } from './ui/properties.js';
import { bindShortcuts, SHORTCUTS } from './ui/shortcuts.js';
import { h, showMenu, toast, download, MOD, SHIFT, ALT } from './ui/dom.js';
import { ICONS } from './ui/icons.js';
import { seedDocument } from './seed.js';
import { emptyDoc } from './core/store.js';
import { exportSVG } from './render/scene.js';

const SAVE_KEY = 'designer-editor:v1';

const editor = new Editor(document.getElementById('canvas'));
const store = editor.store;
window.designer = editor; // handy for debugging and tests

// ---------- load ----------
let loaded = false;
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved && saved.doc && saved.doc.nodes) { store.load(saved.doc, saved.assets || {}); loaded = true; }
  }
} catch { /* storage unavailable */ }
if (!loaded) seedDocument(store);
store.finalize();
store.undoStack = [];
store.emit('doc');

// ---------- save ----------
let saveTimer = null;
store.on((ch) => {
  if (!ch.has('commit')) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ doc: store.doc, assets: store.assets })); } catch { /* full or blocked */ }
  }, 400);
});

// ---------- panels ----------
const layers = new LayersPanel(editor, document.getElementById('layers'));
new PropertiesPanel(editor, document.getElementById('props'), { layers });
new Toolbar(editor, document.getElementById('toolbar'), { onAskAI: (btn) => askAI(btn) });

// ---------- top bar ----------
const fileName = document.getElementById('file-name');
fileName.value = store.doc.name || 'Untitled';
fileName.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') fileName.blur(); });
fileName.addEventListener('change', () => store.transact(() => { store.doc.name = fileName.value.trim() || 'Untitled'; }));

document.getElementById('undo').addEventListener('click', () => store.undo());
document.getElementById('redo').addEventListener('click', () => store.redo());
const zoomBtn = document.getElementById('zoom');
const updateZoom = () => { zoomBtn.textContent = Math.round(store.view.zoom * 100) + '%'; };
store.on((ch) => { if (ch.has('view')) updateZoom(); if (ch.has('commit') || ch.has('doc')) updateUndo(); });
const updateUndo = () => {
  document.getElementById('undo').disabled = !store.undoStack.length;
  document.getElementById('redo').disabled = !store.redoStack.length;
};
zoomBtn.addEventListener('click', () => {
  const r = zoomBtn.getBoundingClientRect();
  showMenu([
    { label: 'Zoom in', shortcut: 'Mod +', action: () => editor.zoomStep(1) },
    { label: 'Zoom out', shortcut: 'Mod -', action: () => editor.zoomStep(-1) },
    { label: 'Zoom to fit', shortcut: 'Shift 1', action: () => editor.zoomToFit() },
    { label: 'Zoom to selection', shortcut: 'Shift 2', action: () => editor.zoomToSelection(), disabled: !store.selection.length },
    '-',
    { label: 'Zoom to 50%', action: () => editor.zoomAt(0.5) },
    { label: 'Zoom to 100%', shortcut: 'Shift 0', action: () => editor.zoomAt(1) },
    { label: 'Zoom to 200%', action: () => editor.zoomAt(2) },
  ], r.right - 220, r.bottom + 6);
});

document.getElementById('main-menu').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu([
    { label: 'Place image…', shortcut: 'Shift Mod K', action: () => editor.pickImages() },
    { label: 'Export page as SVG', action: () => download(`${store.doc.name}.svg`, exportSVG(store, store.doc.root)) },
    { label: editor.comments.showAlways ? 'Hide comments' : 'Show comments', shortcut: 'Shift C', action: () => { editor.comments.showAlways = !editor.comments.showAlways; editor.comments.render(); } },
    { label: 'Keyboard shortcuts', shortcut: 'Shift ?', action: showShortcuts },
    '-',
    { label: 'New blank file', action: () => { if (confirmInline('Start a blank file? This browser keeps only one file.')) { store.load(emptyDoc(), {}); fileName.value = 'Untitled'; } } },
    { label: 'Reset to sample file', action: () => { store.load(emptyDoc(), {}); seedDocument(store); store.finalize(); store.undoStack = []; store.emit('doc'); store.emit('commit'); fileName.value = store.doc.name; } },
  ], r.left, r.bottom + 6);
});

function confirmInline(text) {
  // window.confirm keeps this simple and works everywhere the editor runs
  return window.confirm(text);
}

// ---------- shortcuts sheet ----------
const fmtKey = (k) => k.replace(/Mod /g, MOD).replace(/Shift /g, SHIFT).replace(/Alt /g, ALT);
function showShortcuts() {
  const old = document.querySelector('.dz-sheet');
  if (old) { old.remove(); return; }
  const sheet = h('div', { class: 'dz-sheet', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div', { class: 'dz-sheet-head' }, h('span', {}, 'Keyboard shortcuts'), h('button', { class: 'dz-icon-btn', 'aria-label': 'Close', html: ICONS.close, onclick: () => sheet.remove() })),
    h('div', { class: 'dz-sheet-body' }, ...SHORTCUTS.map(([group, list]) => h('div', { class: 'dz-sheet-group' },
      h('div', { class: 'dz-sheet-title' }, group),
      ...list.map(([label, key]) => h('div', { class: 'dz-sheet-row' }, h('span', {}, label), h('kbd', {}, fmtKey(key))))))),
  );
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.remove(); });
  document.body.append(sheet);
}
editor.showShortcuts = showShortcuts;
document.getElementById('help').addEventListener('click', showShortcuts);

// ---------- Ask AI (placeholder for the workspace's Claude Code bridge) ----------
function askAI(anchor) {
  const old = document.querySelector('.dz-ask');
  if (old) { old.remove(); return; }
  const sel = store.selected();
  const box = h('div', { class: 'dz-ask', role: 'dialog', 'aria-label': 'Ask AI' },
    h('div', { class: 'dz-ask-title', html: `${ICONS.ai}<span>${sel.length ? `Ask about ${sel.length === 1 ? sel[0].name : sel.length + ' layers'}` : 'Ask AI'}</span>` }),
    h('textarea', { rows: 2, placeholder: 'Make this denser, add an empty state, turn this into code…' }),
    h('div', { class: 'dz-ask-foot' },
      h('span', { class: 'dz-muted' }, 'In the Designer app this goes to your local Claude Code.'),
      h('button', { class: 'dz-btn primary', onclick: () => { toast('Sent. Connect the Designer app to run it with Claude Code.'); box.remove(); } }, 'Send')));
  box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') box.remove(); });
  document.body.append(box);
  const r = (anchor || document.getElementById('toolbar')).getBoundingClientRect();
  box.style.left = Math.max(12, Math.min(window.innerWidth - 372, r.left + r.width / 2 - 180)) + 'px';
  box.style.top = r.top - box.offsetHeight - 10 + 'px';
  box.querySelector('textarea').focus();
}

bindShortcuts(editor, { layers, onShortcuts: showShortcuts, onAskAI: () => askAI() });

// ---------- first view ----------
requestAnimationFrame(() => {
  editor.zoomToFit();
  updateZoom();
  updateUndo();
});

