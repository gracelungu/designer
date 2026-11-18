import { describe, expect, it } from 'vitest';
import { Store, defaultLayout, exportSVG } from '../../editor/src/index.js';

describe('canvas pages', () => {
  it('keeps older files editable and moves a layer without changing its identity', () => {
    const store = new Store();
    store.load({ version: 1, name: 'Older file', page: { name: 'Page 1', background: '#FFFFFF' }, root: [], nodes: {}, comments: [] });
    const layer = store.transact(() => store.create('rect'));
    const second = store.addPage();
    store.select([layer.id]);
    store.moveSelectionToPage(second);
    expect(store.allIds()).toEqual([]);
    expect(store.pageForNode(layer.id)).toBe(second);
    expect(store.undo()).toBe(true);
    expect(store.allIds()).toEqual([layer.id]);
    expect(store.redo()).toBe(true);
    expect(store.switchPage(second)).toBe(true);
    expect(store.allIds()).toEqual([layer.id]);
    const reopened = new Store();
    reopened.load(JSON.parse(JSON.stringify(store.doc)));
    expect(reopened.pageForNode(layer.id)).toBe(second);
    expect(reopened.switchPage('page-1')).toBe(true);
    expect(reopened.allIds()).toEqual([]);
  });

  it('duplicates an inactive page with independent layers, reorders it and restores deletions', () => {
    const store = new Store();
    const frame = store.create('frame');
    const layer = store.create('rect', { name: 'Original' }, frame.id);
    const second = store.addPage();
    store.switchPage(second);
    const copy = store.duplicatePage('page-1')!;
    store.reorderPage(copy, -1);
    expect(store.pages().map((p) => p.id ?? 'page-1')).toEqual(['page-1', copy, second]);
    store.switchPage(copy);
    expect(store.allIds().some((id) => id === frame.id || id === layer.id)).toBe(false);
    expect(store.allIds().map((id) => store.get(id)?.name)).toEqual([frame.name, 'Original']);
    store.removePage(copy);
    expect(store.pages()).toHaveLength(2);
    expect(store.undo()).toBe(true);
    expect(store.pages()).toHaveLength(3);
  });
});

describe('editing parity', () => {
  it('wraps children with their own row spacing and respects included layer order', () => {
    const store = new Store();
    const frame = store.create('frame', { w: 140, layout: { ...defaultLayout('horizontal'), wrap: true, rowGap: 18 }, sizing: { h: 'fixed', v: 'hug' } });
    const items = [0, 1, 2].map(() => store.create('rect', { w: 50, h: 24 }, frame.id));
    store.finalize();
    expect(items.map(({ x, y }) => [x, y])).toEqual([[10, 10], [70, 10], [10, 52]]);
    expect(frame.h).toBe(86);
    frame.w = 220;
    store.finalize();
    expect(items.map(({ x, y }) => [x, y])).toEqual([[10, 10], [70, 10], [130, 10]]);
    expect(frame.h).toBe(44);
  });

  it('exports editable gradients as SVG paint servers with ordered stops', () => {
    const store = new Store();
    const layer = store.create('rect', { fills: [{ type: 'linear', angle: 0, stops: [{ offset: 1, color: '#000000' }, { offset: 0, color: '#FFFFFF' }] }] });
    const svg = exportSVG(store, [layer.id]);
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('fill="url(#gradient-');
    expect(svg.indexOf('stop-color="#FFFFFF"')).toBeLessThan(svg.indexOf('stop-color="#000000"'));
    expect(layer.fills[0].stops[0].offset).toBe(1);
  });
});
