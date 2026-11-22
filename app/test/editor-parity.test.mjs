import { describe, expect, it } from 'vitest';
import { Store, emptyDoc } from '../../editor/src/core/store.js';
import { createPrototypeSession, prototypeHotspots, startFrame } from '../../editor/src/core/prototype.js';
import { createGradient } from '../../editor/src/core/gradient.js';
import { defaultLayout, wrappedInsertion } from '../../editor/src/core/layout.js';
import { exportSVG } from '../../editor/src/render/scene.js';
import { cssFor } from '../../editor/src/ui/inspect.js';

describe('local prototypes', () => {
  it('navigates through visible hotspots, tracks history, and restarts from the configured frame', () => {
    const store = new Store();
    const a = store.create('frame');
    const b = store.create('frame');
    const c = store.create('frame');
    const next = store.create('rect', { prototypeAction: { type: 'navigate', target: b.id } }, a.id);
    const back = store.create('rect', { prototypeAction: { type: 'back' } }, b.id);
    const hidden = store.create('group', { visible: false }, a.id);
    store.create('rect', { prototypeAction: { type: 'navigate', target: c.id } }, hidden.id);
    const invalid = store.create('rect', { prototypeAction: { type: 'navigate', target: 'missing' } }, a.id);
    store.doc.prototypeStart = a.id;
    const player = createPrototypeSession(store);
    expect(prototypeHotspots(store, a)).toEqual([next.id]);
    expect(player.activate(invalid.id)).toBe(false);
    expect(player.activate(back.id)).toBe(false);
    expect(player.activate(next.id)).toBe(true);
    expect(player.current).toBe(b);
    expect(player.activate(back.id)).toBe(true);
    expect(player.current).toBe(a);
    player.activate(next.id);
    player.restart();
    expect(player.current).toBe(a);
    expect(player.back()).toBe(false);
    store.remove(a.id);
    expect(startFrame(store)).toBe(b);
    expect(player.activate(next.id)).toBe(false);
  });

  it('remaps cloned destinations and keeps actions through save, load and undo', () => {
    const store = new Store();
    const a = store.create('frame');
    const b = store.create('frame');
    const id = store.create('rect', { prototypeAction: { type: 'navigate', target: b.id } }, a.id).id;
    const [copyA, copyB] = store.insertClones([...store.cloneSubtree(a.id), ...store.cloneSubtree(b.id)], null);
    expect(store.get(store.get(copyA).children[0]).prototypeAction).toEqual({ type: 'navigate', target: copyB });
    const reloaded = new Store();
    reloaded.load(JSON.parse(JSON.stringify(store.doc)));
    reloaded.transact(() => { delete reloaded.get(id).prototypeAction; });
    expect(reloaded.undo()).toBe(true);
    expect(createPrototypeSession(reloaded).activate(id)).toBe(true);
    reloaded.load(emptyDoc());
    expect(createPrototypeSession(reloaded).current).toBeUndefined();
  });
});

describe('wrapping auto layout', () => {
  it('wraps on resize, honors gaps and padding, skips hidden and absolute layers, and hugs height', () => {
    const store = new Store();
    const grid = store.create('frame', {
      x: 10, y: 20, w: 200, sizing: { h: 'fixed', v: 'hug' },
      layout: { ...defaultLayout('horizontal'), wrap: true, gap: 8, rowGap: 12 },
    });
    const card = (extra = {}) => store.create('rect', { w: 80, h: 40, ...extra }, grid.id);
    const a = card();
    const hidden = card({ visible: false });
    const b = card({ h: 30 });
    const absolute = card({ absolute: true, x: 87 });
    const c = card();
    const fill = card({ sizing: { h: 'fill', v: 'fixed' } });
    store.finalize();
    expect([a.x, a.y, b.x, b.y, c.x, c.y, fill.x, fill.y]).toEqual([20, 30, 108, 30, 20, 82, 20, 134]);
    expect([grid.h, fill.w, hidden.x, absolute.x]).toEqual([164, 180, 0, 87]);
    expect(wrappedInsertion(store, grid, { x: 55, y: 100 }, [])).toEqual({ index: 4, x: 20, top: 82, bottom: 122 });
    expect(cssFor(store, grid)).toContain('flex-wrap: wrap');
    store.transact(() => { grid.w = 290; });
    expect([c.x, c.y, fill.w]).toEqual([196, 30, 270]);
    expect(store.undo()).toBe(true);
    expect(store.get(c.id).y).toBe(82);
  });
});

describe('gradient rendering and export', () => {
  it('preserves ordered stops and opacity in SVG and CSS', () => {
    const store = new Store();
    const paint = createGradient('linear', { color: '#334455', opacity: .8 });
    paint.stops.push({ color: '#88AACC', position: 0.3, opacity: 0.5 });
    const n = store.create('rect', { fills: [paint] });
    const svg = exportSVG(store, [n.id]);
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('offset="0.3" stop-color="#88AACC" stop-opacity="0.5"');
    expect(svg.indexOf('offset="0.3"')).toBeLessThan(svg.indexOf('offset="1"'));
    expect(cssFor(store, n)).toContain('linear-gradient(90deg, rgba(51,68,85,0.8) 0%, rgba(136,170,204,0.4) 30%');
    n.fills[0].type = 'radial';
    expect(exportSVG(store, [n.id])).toContain('<radialGradient');
  });

  it('escapes user-supplied paint and identifiers in SVG and ignores non-image URLs', () => {
    const store = new Store();
    store.assets.outside = 'https://example.invalid/image.png';
    const node = store.create('rect', {
      id: 'Layer "A" & B',
      fills: [{ type: 'solid', color: 'rgb("1","2","3")' }, { type: 'image', asset: 'outside' }],
    });
    const svg = exportSVG(store, [node.id]);
    expect(svg).toContain('data-id="Layer &quot;A&quot; &amp; B"');
    expect(svg).toContain('fill="rgb(&quot;1&quot;,&quot;2&quot;,&quot;3&quot;)"');
    expect(svg).not.toContain('example.invalid');
  });

  it('retains the parent transform when exporting a nested layer', () => {
    const store = new Store();
    const frame = store.create('frame', { rotation: 90 });
    const layer = store.create('rect', { w: 10, h: 20 }, frame.id);
    expect(exportSVG(store, [layer.id])).toContain('<g transform="matrix(');
  });
});
