// Design <-> code sync on the canvas side: snapshots, diffs, three-way merges and the controller,
// run against the real editor store (no browser needed).
import { describe, expect, it, vi } from 'vitest';
import { Store, solid, defaultLayout } from '../../editor/src/index.js';
import type { EditorNode } from '../../editor/src/index.js';
import type { SyncJob } from '../src/shared/protocol';
import { SyncController } from '../src/web/sync/controller';
import { acceptChanges, applySnap, cssColor, diffSnap, ensureBaselines, filesFor, isLinked, mergeFromCode, pendingChanges, snapshot, stylesToSnap, syncOf } from '../src/web/sync/model';

/** A linked "Button" design: a horizontal auto-layout frame with a text label. */
function button(store: Store) {
  const f = store.create('frame', { x: 0, y: 0, w: 120, h: 40, name: 'Button' }) as EditorNode;
  f.fills = [solid('#111111')];
  f.radius = 6;
  f.layout = { ...defaultLayout('horizontal'), gap: 8, padding: { t: 10, r: 16, b: 10, l: 16 } };
  f.sizing = { h: 'hug', v: 'hug' };
  const t = store.create('text', { name: 'Label' }, f.id) as EditorNode;
  Object.assign(t.text, { content: 'Buy now', fontSize: 14, fontWeight: 600, fontFamily: 'Inter' });
  t.fills = [solid('#FFFFFF')];
  f.codeLink = { storyId: 'ui-button--primary', file: 'src/Button.stories.tsx', exportName: 'Primary' };
  return f;
}

/** What the probe reports for that button when rendered from code. */
const rendered = (over: Record<string, string> = {}): Record<string, string> => ({
  tag: 'button',
  display: 'inline-flex',
  flexDirection: 'row',
  gap: '8px',
  paddingTop: '10px',
  paddingRight: '16px',
  paddingBottom: '10px',
  paddingLeft: '16px',
  backgroundColor: 'rgb(17, 17, 17)',
  color: 'rgb(255, 255, 255)',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
  borderTopColor: 'rgb(0, 0, 0)',
  borderTopLeftRadius: '6px',
  borderTopRightRadius: '6px',
  borderBottomRightRadius: '6px',
  borderBottomLeftRadius: '6px',
  opacity: '1',
  fontFamily: '"Inter", sans-serif',
  fontSize: '14px',
  fontWeight: '600',
  lineHeight: 'normal',
  ...over,
});

describe('snapshots', () => {
  it('reads a design layer and its label in design terms', () => {
    const store = new Store();
    const b = button(store);
    expect(snapshot(store, b)).toMatchObject({ fill: '#111111', radius: 6, layout: 'horizontal', gap: 8, padding: [10, 16, 10, 16], content: 'Buy now', fontSize: 14, fontWeight: 600, textColor: '#FFFFFF' });
    // Hug sizing: size follows content, so it isn't something to sync.
    expect(snapshot(store, b)).not.toHaveProperty('w');
  });

  it('reads a live component as its props', () => {
    const store = new Store();
    const c = store.create('code', { name: 'Button / Primary' }) as EditorNode;
    c.code = { kind: 'component', src: null, title: 'Button', hug: true, args: { size: 'lg', disabled: false }, storyId: 'ui-button--primary', file: 'src/Button.stories.tsx' };
    expect(snapshot(store, c)).toEqual({ 'arg:size': 'lg', 'arg:disabled': false });
    expect(isLinked(c)).toBe(true);
  });

  it('turns rendered CSS into the same shape, so design and code compare directly', () => {
    const store = new Store();
    const design = snapshot(store, button(store));
    const code = stylesToSnap(rendered());
    expect(diffSnap(design, code, ['fill', 'radius', 'layout', 'gap', 'padding', 'fontSize', 'fontWeight', 'textColor', 'fontFamily'])).toEqual([]);
    expect(stylesToSnap(rendered({ borderTopWidth: '2px', borderTopStyle: 'solid', borderTopColor: '#2563eb', borderTopLeftRadius: '4px' }))).toMatchObject({ stroke: '#2563EB', strokeWidth: 2, radius: [4, 6, 6, 6] });
    expect(stylesToSnap(rendered({ display: 'block' }))).not.toHaveProperty('padding');
  });

  it('normalises colours', () => {
    expect(cssColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(cssColor('rgba(255, 0, 0, 0.5)')).toBe('#FF000080');
    expect(cssColor('#abc')).toBe('#AABBCC');
  });
});

describe('design -> code', () => {
  it('a linked layer gets a baseline, and canvas edits show up as pending with CSS', () => {
    const store = new Store();
    const b = button(store);
    const plain = store.create('rect', { name: 'Not linked' }) as EditorNode;
    expect(ensureBaselines(store)).toEqual([b.id]);
    expect(pendingChanges(store)).toEqual([]);
    b.fills = [solid('#2563EB')];
    b.radius = 12;
    plain.fills = [solid('#FF0000')];
    const p = pendingChanges(store);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ layerId: b.id, kind: 'design', storyId: 'ui-button--primary', file: 'src/Button.stories.tsx', exportName: 'Primary' });
    expect(p[0].changes).toEqual([
      { prop: 'fill', label: 'Fill', from: '#111111', to: '#2563EB', css: 'background-color: #2563EB' },
      { prop: 'radius', label: 'Corner radius', from: 6, to: 12, css: 'border-radius: 12px' },
    ]);
  });

  it('label text and prop edits count too', () => {
    const store = new Store();
    const b = button(store);
    const c = store.create('code', { name: 'Badge' }) as EditorNode;
    c.code = { kind: 'component', src: null, title: 'Badge', hug: true, args: { tone: 'info' }, storyId: 'ui-badge--default' };
    ensureBaselines(store);
    store.get(b.children![0])!.text.content = 'Checkout';
    c.code.args = { tone: 'danger' };
    const p = pendingChanges(store);
    expect(p.map((l) => [l.kind, l.changes.map((x) => `${x.label}:${String(x.to)}`)])).toEqual([
      ['design', ['Text:Checkout']],
      ['component', ['Prop tone:danger']],
    ]);
  });

  it('keeping the code change makes what was sent the new common ground, later edits stay pending', () => {
    const store = new Store();
    const b = button(store);
    ensureBaselines(store);
    b.fills = [solid('#2563EB')];
    const sent = pendingChanges(store);
    b.radius = 20; // edited while Claude worked
    acceptChanges(store, sent);
    expect(pendingChanges(store)[0].changes.map((c) => c.prop)).toEqual(['radius']);
  });

  it('applySnap writes design properties back (revert)', () => {
    const store = new Store();
    const b = button(store);
    ensureBaselines(store);
    b.fills = [solid('#2563EB')];
    b.layout.gap = 20;
    store.get(b.children![0])!.text.fontSize = 18;
    applySnap(store, b, syncOf(b).base!);
    expect(pendingChanges(store)).toEqual([]);
  });
});

describe('code -> design (three-way merge)', () => {
  const base = { fill: '#111111', radius: 6, gap: 8 };
  it('takes what only code changed', () => {
    const r = mergeFromCode({ base, current: base, codeBefore: base, codeAfter: { ...base, fill: '#2563EB' } });
    expect(r).toEqual({ apply: { fill: '#2563EB' }, conflicts: [] });
  });
  it('leaves alone what code did not touch, even if the design differs', () => {
    const r = mergeFromCode({ base, current: { ...base, radius: 20 }, codeBefore: base, codeAfter: { ...base, fill: '#2563EB' } });
    expect(r.apply).toEqual({ fill: '#2563EB' });
    expect(r.conflicts).toEqual([]);
  });
  it('asks when both sides changed the same property differently', () => {
    const r = mergeFromCode({ base, current: { ...base, fill: '#FF0000' }, codeBefore: base, codeAfter: { ...base, fill: '#2563EB' } });
    expect(r.apply).toEqual({});
    expect(r.conflicts).toEqual([{ prop: 'fill', label: 'Fill', mine: '#FF0000', code: '#2563EB' }]);
  });
  it('agreeing changes are not conflicts', () => {
    const r = mergeFromCode({ base, current: { ...base, fill: '#2563EB' }, codeBefore: base, codeAfter: { ...base, fill: '#2563eb' } });
    expect(r).toEqual({ apply: {}, conflicts: [] });
  });
  it('with no record of the code before, every difference is a question', () => {
    const r = mergeFromCode({ current: base, codeAfter: { ...base, radius: 8, fontSize: 14 } });
    expect(r.conflicts.map((c) => c.prop)).toEqual(['radius']); // fontSize: the layer has no text to compare
  });
});

describe('which changed files belong to a layer', () => {
  it('matches the story file and files named like the component next to it', () => {
    const n = { type: 'frame', codeLink: { file: 'src/ui/Button.stories.tsx' } } as unknown as EditorNode;
    expect(filesFor(n, ['src/ui/Button.tsx', 'src/ui/Button.module.css', 'src/ui/Card.tsx', 'src/ui/sub/Button.tsx', 'README.md'])).toEqual(['src/ui/Button.tsx', 'src/ui/Button.module.css']);
  });
});

describe('SyncController', () => {
  function setup(measure: (id: string) => Promise<Record<string, string>> = vi.fn(async () => rendered())) {
    const store = new Store();
    const b = button(store);
    const calls: { path: string; body?: unknown }[] = [];
    const replies: Record<string, (body: unknown) => unknown> = {};
    const api = async <T,>(path: string, body?: unknown): Promise<T> => {
      calls.push({ path, body });
      return (replies[path]?.(body) ?? []) as T;
    };
    const reloadLive = vi.fn();
    const sync = new SyncController({ store, measure, reloadLive, api, settleMs: 0 });
    return { store, b, sync, calls, replies, measure, reloadLive };
  }
  const job = (o: Partial<SyncJob>): SyncJob => ({ id: 'j1', layers: [], status: 'review', progress: [], files: [], summary: '', createdAt: 1, ...o });

  it('tracks new links on commit, recording how the code renders', async () => {
    const { store, b, sync, measure } = setup();
    store.transact(() => void (b.name = 'Button'));
    (store as unknown as { flush(): void }).flush();
    await vi.waitFor(() => expect(syncOf(b).code).toBeTruthy());
    expect(measure).toHaveBeenCalledWith('ui-button--primary');
    expect(sync.pending()).toEqual([]);
  });

  it('sends pending edits, then Keep accepts them', async () => {
    const { store, b, sync, calls, replies } = setup();
    sync.track();
    store.transact(() => void (b.fills = [solid('#2563EB')]));
    replies['/api/sync/to-code'] = (body) => job({ status: 'running', layers: (body as { layers: SyncJob['layers'] }).layers });
    await sync.sendToCode();
    expect(calls.at(-1)!.body).toMatchObject({ layers: [{ layerId: b.id, changes: [{ prop: 'fill', to: '#2563EB' }] }] });
    expect(sync.active()[0].status).toBe('running');
    const sent = (calls.at(-1)!.body as { layers: SyncJob['layers'] }).layers;
    replies['/api/sync/keep'] = () => job({ status: 'kept', layers: sent });
    await sync.keep('j1');
    expect(sync.pending()).toEqual([]);
    expect(sync.active()).toEqual([]);
  });

  it('Discard leaves the canvas edit pending', async () => {
    const { store, b, sync, replies } = setup();
    sync.track();
    store.transact(() => void (b.radius = 2));
    replies['/api/sync/discard'] = () => job({ status: 'discarded' });
    await sync.discard('j1');
    expect(sync.pending()).toHaveLength(1);
  });

  it('refuses to send when nothing changed', async () => {
    const { sync } = setup();
    sync.track();
    await expect(sync.sendToCode()).rejects.toThrow(/no canvas changes/);
  });

  it('a pull that recoloured the component recolours the linked design', async () => {
    const measure = vi.fn(async () => rendered());
    const { b, sync, reloadLive, store } = setup(measure);
    sync.track();
    await vi.waitFor(() => expect(syncOf(b).code).toBeTruthy());
    measure.mockResolvedValue(rendered({ backgroundColor: 'rgb(37, 99, 235)', borderTopLeftRadius: '8px', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px' }));
    const out = await sync.onCodeChanged({ from: 'a', to: 'b', files: ['src/Button.tsx'], reason: 'pull' });
    expect(reloadLive).toHaveBeenCalled();
    expect(snapshot(store, b)).toMatchObject({ fill: '#2563EB', radius: 8 });
    expect(out[0].applied.map((c) => c.label)).toEqual(['Fill', 'Corner radius']);
    expect(out[0].files).toEqual(['src/Button.tsx']);
    // Design and code agree again: nothing pending, nothing incoming.
    expect(sync.pending()).toEqual([]);
    expect(sync.incoming()).toEqual([]);
  });

  it('a pull that changed something the designer also edited asks, and both answers work', async () => {
    const measure = vi.fn(async () => rendered());
    const { b, sync, store } = setup(measure);
    sync.track();
    await vi.waitFor(() => expect(syncOf(b).code).toBeTruthy());
    store.transact(() => void (b.fills = [solid('#FF0000')]));
    measure.mockResolvedValue(rendered({ backgroundColor: 'rgb(37, 99, 235)' }));
    await sync.onCodeChanged({ from: 'a', to: 'b', files: [], reason: 'pull' });
    expect(snapshot(store, b).fill).toBe('#FF0000');
    expect(sync.incoming().map((n) => n.id)).toEqual([b.id]);

    // Keep my design: it becomes a canvas edit to send to code.
    sync.resolve(b.id, 'design');
    expect(sync.incoming()).toEqual([]);
    expect(sync.pending()[0].changes).toMatchObject([{ prop: 'fill', from: '#2563EB', to: '#FF0000' }]);

    // Or use the code: the design takes the code's value.
    measure.mockResolvedValue(rendered({ backgroundColor: 'rgb(0, 128, 0)' }));
    await sync.onCodeChanged({ from: 'b', to: 'c', files: [], reason: 'pull' });
    sync.resolve(b.id, 'code');
    expect(snapshot(store, b).fill).toBe('#008000');
    expect(sync.pending()).toEqual([]);
  });

  it('reports layers it could not check (Storybook not running)', async () => {
    const measure = vi.fn(async (): Promise<Record<string, string>> => {
      throw new Error('Storybook is not running');
    });
    const { sync } = setup(measure);
    sync.track();
    const out = await sync.onCodeChanged({ from: 'a', to: 'b', files: [], reason: 'head' });
    expect(out[0].error).toMatch(/Storybook/);
  });
});
