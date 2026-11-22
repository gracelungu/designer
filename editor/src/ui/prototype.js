import { createPrototypeSession, prototypeFrames, prototypeHotspots, screenFor, startFrame } from '../core/prototype.js';
import { Store } from '../core/store.js';
import { exportSVG } from '../render/scene.js';
import { h } from './dom.js';

export function prototypePanel(editor) {
  const store = editor.store;
  const frames = prototypeFrames(store);
  const [selected] = store.selection.length === 1 ? store.selected() : [];
  const screen = screenFor(store, selected);
  const frame = frames.find((n) => n.id === selected?.id);
  const start = startFrame(store);
  const play = h('button', { class: 'dz-btn', disabled: !start, onclick: () => playPrototype(editor) }, 'Play prototype');
  const controls = [h('div', { class: 'dz-row-btns' }, play,
    frame && h('button', { class: 'dz-btn', onclick: () => playPrototype(editor, frame.id) }, 'Play from here'))];
  if (!start) return [...controls, h('p', { class: 'dz-muted' }, 'Add a top-level frame to start a prototype.')];
  controls.push(h('p', { class: 'dz-muted' }, `Start frame: ${start.name}`));
  if (frame && frame.id !== start.id) {
    controls.push(h('button', { class: 'dz-btn', onclick: () => store.transact(() => { store.doc.prototypeStart = frame.id; }) }, 'Set as start frame'));
  }
  if (!screen) return [...controls, h('p', { class: 'dz-muted' }, 'Select a frame or one of its layers to add a click interaction.')];

  const id = selected.id;
  const action = h('select', { class: 'dz-select', 'aria-label': 'On click action' });
  const targets = frames.filter((n) => n.id !== screen.id);
  action.append(h('option', { value: '' }, 'None'));
  if (targets.length) action.append(h('option', { value: 'navigate' }, 'Navigate to frame'));
  action.append(h('option', { value: 'back' }, 'Go back'));
  const current = selected.prototypeAction;
  action.value = current?.type === 'back' || (current?.type === 'navigate' && targets.length) ? current.type : '';
  const destination = h('select', { class: 'dz-select', 'aria-label': 'Destination frame' });
  destination.append(h('option', { value: '', disabled: true }, 'Choose a destination'));
  for (const n of targets) destination.append(h('option', { value: n.id }, n.name));
  destination.value = targets.some((n) => n.id === current?.target) ? current.target : '';
  destination.hidden = action.value !== 'navigate';
  const save = () => {
    const node = store.get(id);
    if (!node) return;
    if (action.value === 'navigate' && !destination.value) return;
    store.transact(() => {
      if (action.value === 'navigate') node.prototypeAction = { type: 'navigate', target: destination.value };
      else if (action.value === 'back') node.prototypeAction = { type: 'back' };
      else delete node.prototypeAction;
    });
  };
  action.addEventListener('change', () => {
    destination.hidden = action.value !== 'navigate';
    if (!destination.hidden && !destination.value) destination.focus();
    save();
  });
  destination.addEventListener('change', save);
  return [...controls, h('label', { class: 'dz-prototype-label' }, 'On click', action), destination];
}

export function playPrototype(editor, initialFrame) {
  const store = new Store();
  store.doc = structuredClone(editor.store.doc);
  store.assets = { ...editor.store.assets };
  const session = createPrototypeSession(store, initialFrame);
  if (!session.current) return;
  const dialog = h('dialog', { class: 'dz-prototype-dialog', 'aria-label': 'Prototype preview', 'data-canvas-keys': 'off' });
  const title = h('strong', { 'aria-live': 'polite' });
  const stage = h('div', { class: 'dz-prototype-stage' });
  const back = h('button', { class: 'dz-btn', onclick: () => { if (session.back()) render(); } }, 'Back');
  const restart = h('button', { class: 'dz-btn', onclick: () => { session.restart(); render(); } }, 'Restart');
  const close = h('button', { class: 'dz-btn', onclick: () => dialog.close() }, 'Close preview');
  const view = h('div', { class: 'dz-prototype-screen' });
  let url;
  function fit() {
    const box = store.worldBox(session.current.id);
    const scale = Math.max(0, Math.min(1, (stage.clientWidth - 24) / box.w, (stage.clientHeight - 24) / box.h));
    view.style.width = `${box.w * scale}px`;
    view.style.height = `${box.h * scale}px`;
  }
  function render() {
    const frame = session.current;
    const box = store.worldBox(frame.id);
    title.textContent = frame.name;
    back.disabled = !session.canGoBack;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([exportSVG(store, [frame.id])], { type: 'image/svg+xml' }));
    view.replaceChildren(h('img', { src: url, alt: frame.name, draggable: 'false' }));
    fit();
    for (const id of prototypeHotspots(store, frame)) {
      const node = store.get(id);
      if (node.prototypeAction.type === 'back' && !session.canGoBack) continue;
      const hit = store.worldBox(id);
      const clips = [box, hit, ...store.ancestors(id).filter((n) => n.clip).map((n) => store.worldBox(n.id))];
      const left = Math.max(...clips.map((b) => b.x)), top = Math.max(...clips.map((b) => b.y));
      const right = Math.min(...clips.map((b) => b.x + b.w)), bottom = Math.min(...clips.map((b) => b.y + b.h));
      if (left >= right || top >= bottom) continue;
      view.append(h('button', {
        class: 'dz-prototype-hotspot', 'aria-label': node.name,
        style: {
          left: `${100 * (left - box.x) / box.w}%`, top: `${100 * (top - box.y) / box.h}%`,
          width: `${100 * (right - left) / box.w}%`, height: `${100 * (bottom - top) / box.h}%`,
        },
        onclick: () => { if (session.activate(id)) { render(); title.focus(); } },
      }));
    }
  }
  title.tabIndex = -1;
  stage.append(view);
  dialog.append(h('header', {}, title, h('div', { class: 'dz-row-btns' }, back, restart, close)), stage);
  document.body.append(dialog);
  dialog.showModal();
  const resize = new ResizeObserver(fit);
  resize.observe(stage);
  dialog.addEventListener('close', () => {
    resize.disconnect();
    if (url) URL.revokeObjectURL(url);
    dialog.remove();
  }, { once: true });
  render();
  close.focus();
}
