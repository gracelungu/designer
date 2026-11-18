// A small sample file so the editor opens with something to try.

import { solid } from './core/model.js';

export function seedDocument(store) {
  store.doc.name = 'Sample file';
  const phone = store.create('frame', { x: 0, y: 0, w: 393, h: 852, name: 'Plans' });
  const title = store.create('text', { x: 24, y: 72, name: 'Choose a plan' }, phone.id);
  Object.assign(title.text, { content: 'Choose a plan', fontSize: 28, fontWeight: 600 });

  const sub = store.create('text', { x: 24, y: 112, w: 345, name: 'Subtitle' }, phone.id);
  Object.assign(sub.text, { content: 'Start free and upgrade when your team grows.', fontSize: 15, autoResize: 'height' });
  sub.fills = [solid('#6B6B6B')];

  const avatar = store.create('ellipse', { x: 329, y: 20, w: 40, h: 40, name: 'Avatar' }, phone.id);
  avatar.fills = [solid('#E4E4E7')];
  avatar.constraints = { h: 'right', v: 'top' };

  const list = store.create('frame', { x: 24, y: 170, w: 345, h: 200, name: 'Plan list', fills: [], clip: false }, phone.id);
  list.layout = { mode: 'vertical', gap: 12, padding: { t: 0, r: 0, b: 0, l: 0 }, primary: 'start', counter: 'start' };
  list.sizing = { h: 'fixed', v: 'hug' };

  const plans = [['Starter', 'Free', 'For trying things out', false], ['Pro', '€12 / month', 'For growing teams', true]];
  for (const [name, price, desc, primary] of plans) {
    const card = store.create('frame', { x: 24, y: 170, w: 345, h: 100, name: `${name} card`, radius: 12 }, list.id);
    card.fills = [solid(primary ? '#111111' : '#F4F4F5')];
    card.layout = { mode: 'vertical', gap: 6, padding: { t: 16, r: 16, b: 16, l: 16 }, primary: 'start', counter: 'start' };
    card.sizing = { h: 'fill', v: 'hug' };
    const fg = primary ? '#FFFFFF' : '#111111';
    const t1 = store.create('text', { name }, card.id);
    Object.assign(t1.text, { content: name, fontSize: 16, fontWeight: 600 });
    t1.fills = [solid(fg)];
    const t2 = store.create('text', { name: 'Price' }, card.id);
    Object.assign(t2.text, { content: price, fontSize: 22, fontWeight: 600 });
    t2.fills = [solid(fg)];
    const t3 = store.create('text', { name: 'Description' }, card.id);
    Object.assign(t3.text, { content: desc, fontSize: 13 });
    t3.fills = [solid(primary ? '#A1A1AA' : '#6B6B6B')];
    const btn = store.create('frame', { name: 'Button', radius: 8 }, card.id);
    btn.fills = [solid(primary ? '#FFFFFF' : '#111111')];
    btn.layout = { mode: 'horizontal', gap: 8, padding: { t: 8, r: 14, b: 8, l: 14 }, primary: 'center', counter: 'center' };
    btn.sizing = { h: 'hug', v: 'hug' };
    const label = store.create('text', { name: 'Label' }, btn.id);
    Object.assign(label.text, { content: `Choose ${name}`, fontSize: 13, fontWeight: 600 });
    label.fills = [solid(primary ? '#111111' : '#FFFFFF')];
  }

  const star = store.create('star', { x: 480, y: 40, w: 120, h: 120, name: 'Star 1' });
  star.fills = [solid('#FACC15')];
  const note = store.create('text', { x: 480, y: 190, w: 260, name: 'Tip' });
  Object.assign(note.text, { content: 'Tip: press F and pick a device on the right, or draw with R, O, L, P and T.', fontSize: 14, autoResize: 'height' });
  note.fills = [solid('#3F3F46')];
  store.selection = [];
}
