import * as C from '../core/commands.js';
import { startFrame } from '../core/prototype.js';
import { TOOL_INFO } from '../editor.js';
import { h, keyLabel } from './dom.js';
import { playPrototype } from './prototype.js';

export function showQuickActions(editor, { layers, onShortcuts } = {}) {
  const { store } = editor;
  const hasSelection = store.selection.length > 0;
  const actions = [
    ['Zoom to fit', 'Shift 1', () => editor.zoomToFit()],
    ['Zoom to selection', 'Shift 2', () => editor.zoomToSelection(), hasSelection],
    ['Zoom to 100%', 'Shift 0', () => editor.zoomAt(1)],
    ['Undo', 'Mod Z', () => store.undo(), store.undoStack.length > 0],
    ['Redo', 'Shift Mod Z', () => store.redo(), store.redoStack.length > 0],
    ['Group selection', 'Mod G', () => C.group(store), hasSelection],
    ['Frame selection', 'Alt Mod G', () => C.frameSelection(store), hasSelection],
    ['Add auto layout', 'Shift A', () => C.addAutoLayout(store), hasSelection],
    ['Remove auto layout', 'Alt Shift A', () => C.removeAutoLayout(store), store.selected().some((n) => n.layout)],
    ['Rename layer', 'Mod R', () => layers.renameSelected(), hasSelection && !!layers],
    ['Play prototype', '', () => playPrototype(editor), !!startFrame(store)],
    ['Show keyboard shortcuts', 'Shift ?', () => onShortcuts(), !!onShortcuts],
    ...Object.entries(TOOL_INFO).map(([id, tool]) => [tool.label, tool.key, () => {
      if (id === 'image') editor.pickImages();
      else editor.setTool(id);
    }]),
  ];
  const dialog = h('dialog', { class: 'dz-quick-actions', 'aria-label': 'Quick actions', 'data-canvas-keys': 'off' });
  const input = h('input', { type: 'search', placeholder: 'Search commands…', 'aria-label': 'Search commands',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'dz-action-results', 'aria-autocomplete': 'list' });
  const results = h('div', { class: 'dz-action-results', id: 'dz-action-results', role: 'listbox', 'aria-label': 'Commands' });
  const empty = h('p', { class: 'dz-empty', role: 'status' }, 'No commands found.');
  dialog.append(input, results, empty);
  let matches = [];
  let active = 0;
  let nextAction;
  const run = (index) => {
    nextAction = matches[index]?.[2];
    if (nextAction) dialog.close();
  };
  function updateActive(scroll = false) {
    for (const [i, row] of [...results.children].entries()) row.setAttribute('aria-selected', String(i === active));
    const row = results.children[active];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function filter() {
    const words = input.value.toLowerCase().trim().split(/\s+/);
    matches = actions.filter(([label, , , enabled = true]) => enabled && words.every((word) => label.toLowerCase().includes(word)));
    active = 0;
    results.replaceChildren(...matches.map(([label, shortcut], i) => h('div', {
      role: 'option', class: 'dz-action-option', id: `dz-action-${i}`, onclick: () => run(i),
      onpointerdown: (e) => e.preventDefault(),
    }, label, h('span', { class: 'dz-muted' }, keyLabel(shortcut)))));
    empty.hidden = matches.length > 0;
    updateActive();
  }
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(active); }
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      updateActive(true);
    }
  });
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    nextAction?.();
  }, { once: true });
  filter();
  dialog.showModal();
  input.focus();
}
