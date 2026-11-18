// Creates the canvas editor once, with its toolbar, layers and properties panels, so React can
// place those panels in the app's own sidebars without remounting them.
import { bindShortcuts, cssFor, emptyDoc, Editor, exportSVG, LayersPanel, PropertiesPanel, Toolbar, type EditorNode } from '../../../../editor/src/index.js';
import type { CanvasComment, CanvasOp, PreviewFrame } from '../../shared/protocol';
import { api } from '../api';
import { buildNodes, canvasState, freeSpot, placeAt, selectionContext, storyIds, applySimple } from './convert';

export interface CanvasHost {
  editor: Editor;
  stage: HTMLDivElement;
  layersEl: HTMLDivElement;
  propsEl: HTMLDivElement;
  /** Loads the canvas saved for the open project (or Designer's own folder). */
  load(): Promise<void>;
  apply(op: CanvasOp): Promise<unknown>;
  placeStory(storyId: string, opts?: { nextToSelection?: boolean; title?: string; file?: string; args?: Record<string, unknown> }): Promise<string>;
  showPage(url: string, name?: string): Promise<string>;
  state(): ReturnType<typeof canvasState>;
  context(): ReturnType<typeof selectionContext>;
  /** Comments as the canvas has them now. */
  comments(): CanvasComment[];
  /** Takes comments saved elsewhere (a teammate's, after Get latest, or Claude's replies). */
  setComments(list: CanvasComment[]): void;
  /** Every top-level frame drawn for a shareable preview. */
  previewFrames(): PreviewFrame[];
}

let host: CanvasHost | undefined;

export function canvasHost(onAskAI: () => void): CanvasHost {
  if (host) return host;
  const stage = document.createElement('div');
  stage.className = 'canvas-stage';
  const root = document.createElement('div');
  root.className = 'canvas-root';
  const toolbarEl = document.createElement('div');
  stage.append(root, toolbarEl);
  const editor = new Editor(root);
  const store = editor.store;
  const layersEl = document.createElement('div');
  layersEl.className = 'layers-host';
  const propsEl = document.createElement('div');
  propsEl.className = 'props-host';
  const layers = new LayersPanel(editor, layersEl);
  new PropertiesPanel(editor, propsEl, { layers });
  new Toolbar(editor, toolbarEl, { onAskAI });
  bindShortcuts(editor, { layers, onAskAI });

  // Save the canvas next to the project (in .designer/canvas.json), so it travels with the repo.
  // Comments are saved on their own, one file per thread, as soon as they change.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let savedComments = '[]';
  store.on((ch) => {
    if (!ch.has('commit') || loading) return;
    const comments = JSON.stringify(store.doc.comments ?? []);
    if (comments !== savedComments) {
      savedComments = comments;
      void api('/api/comments', { comments: store.doc.comments ?? [] }).catch(() => undefined);
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void api('/api/canvas', { data: { version: 1, doc: store.doc, assets: store.assets } }).catch(() => undefined), 600);
  });

  const storySrc = async (ids: Iterable<string>) => {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = (await api<{ src: string }>(`/api/story-src?id=${encodeURIComponent(id)}`)).src;
    return out;
  };

  const focusOn = (ids: string[]) => {
    store.select(ids);
    const b = store.selectionBox(ids);
    if (!b) return;
    const v = editor.viewRect();
    // Only move the camera when the new layers are out of sight.
    if (b.x < v.x || b.y < v.y || b.x + b.w > v.x + v.w || b.y + b.h > v.y + v.h) editor.zoomToBox(b, { max: Math.max(store.view.zoom, 0.25) });
  };

  host = {
    editor,
    stage,
    layersEl,
    propsEl,
    async load() {
      clearTimeout(saveTimer);
      loading = true;
      try {
        const r = await api<{ data: { doc?: { comments?: unknown[] }; assets?: Record<string, string> } | null; comments?: CanvasComment[]; author?: string }>('/api/canvas').catch(() => ({ data: null, comments: [] as CanvasComment[], author: undefined }));
        const data = r.data;
        if (data && data.doc) store.load(data.doc, data.assets ?? {});
        else store.load(emptyDoc(), {});
        store.doc.comments = r.comments ?? [];
        savedComments = JSON.stringify(store.doc.comments);
        if (r.author) editor.comments.author = r.author;
        store.view.x = 0;
        store.view.y = 0;
        store.view.zoom = 1;
        // Live renders get fresh addresses each run; drop stale ones until they're shown again.
        for (const id of store.allIds()) {
          const n = store.get(id);
          if (n?.type === 'code' && n.code) n.code.src = null;
        }
        store.emit('doc');
        requestAnimationFrame(() => (store.doc.root.length ? editor.zoomToFit() : undefined));
      } finally {
        setTimeout(() => (loading = false), 50);
      }
    },
    async apply(op) {
      switch (op.kind) {
        case 'add-nodes': {
          const srcs = await storySrc(storyIds(op.nodes)).catch(() => ({}));
          const hasPos = op.nodes.some((n) => n.x !== undefined || n.y !== undefined);
          const ids = store.transact(() => {
            const made = buildNodes(store, op.nodes, srcs);
            if (op.nextToSelection || !hasPos) {
              const spot = freeSpot(store, !!op.nextToSelection);
              placeAt(store, made, spot.x, spot.y);
            }
            return made;
          });
          if (op.select !== false) focusOn(ids);
          return { added: ids };
        }
        case 'update-nodes': {
          const missing: string[] = [];
          store.transact(() => {
            for (const u of op.updates) {
              const n = store.get(u.id);
              if (!n) {
                missing.push(u.id);
                continue;
              }
              applySimple(store, n, u);
              if (u.x !== undefined || u.y !== undefined) {
                const p = n.parent ? store.get(n.parent) : null;
                const tx = (p ? p.x : 0) + (u.x ?? n.x - (p ? p.x : 0));
                const ty = (p ? p.y : 0) + (u.y ?? n.y - (p ? p.y : 0));
                store.moveBy(n.id, tx - n.x, ty - n.y);
              }
            }
          });
          return { updated: op.updates.length - missing.length, missing };
        }
        case 'show-component':
          return { id: await host!.placeStory(op.storyId, { nextToSelection: op.nextToSelection, title: op.title, file: op.file, args: op.args }) };
        case 'show-page':
          return { id: await host!.showPage(op.url, op.name) };
        case 'select':
          focusOn(op.ids);
          return { selected: op.ids };
      }
    },
    async placeStory(storyId, opts = {}) {
      const src = (await storySrc([storyId]))[storyId];
      const id = store.transact(() => {
        const spot = freeSpot(store, opts.nextToSelection ?? store.selection.length > 0);
        const n = store.create('code', { x: spot.x, y: spot.y, name: opts.title ?? storyId });
        n.code = { kind: 'component', src, title: opts.title ?? storyId, hug: true, args: opts.args ?? {}, storyId, file: opts.file };
        return n.id;
      });
      focusOn([id]);
      return id;
    },
    async showPage(url, name) {
      const { src } = await api<{ src: string }>(`/api/preview?url=${encodeURIComponent(url)}`);
      const origin = new URL(url).origin;
      // Reuse the frames already showing this app; their address changes when the server restarts.
      const existing = store.allIds().map((id) => store.get(id)!).filter((n: EditorNode) => n.type === 'code' && n.code?.kind === 'page' && n.code.url && new URL(n.code.url).origin === origin);
      if (existing.length) {
        for (const n of existing) n.code!.src = src.replace(/^(http:\/\/[^/]+).*/, '$1') + new URL(n.code!.url!).pathname;
        store.emit('doc');
        return existing[0].id;
      }
      const id = store.transact(() => {
        const spot = freeSpot(store, false);
        const n = store.create('code', { x: spot.x, y: spot.y, w: 1280, h: 800, name: name ?? `App · ${new URL(url).pathname}` });
        n.code = { kind: 'page', src, url, title: n.name, hug: false, args: {} };
        return n.id;
      });
      focusOn([id]);
      return id;
    },
    comments: () => (store.doc.comments ?? []) as CanvasComment[],
    setComments(list) {
      const next = JSON.stringify(list);
      if (next === JSON.stringify(store.doc.comments ?? [])) return;
      savedComments = next;
      store.doc.comments = list;
      if (editor.comments.openId && !list.some((c) => c.id === editor.comments.openId)) editor.comments.close();
      editor.comments.render();
      store.emit('comments');
    },
    previewFrames() {
      const tops = store.doc.root.map((id) => store.get(id)!).filter((n) => n && n.visible !== false && ['frame', 'code', 'group', 'component', 'instance'].includes(n.type));
      const comments = (store.doc.comments ?? []) as CanvasComment[];
      const inside = (id: string, top: string): boolean => {
        for (let n = store.get(id); n; n = n.parent ? store.get(n.parent) : undefined) if (n.id === top) return true;
        return false;
      };
      return tops.map((n) => {
        const box = store.worldBox(n.id);
        const components: PreviewFrame['components'] = [];
        const walk = (id: string) => {
          const c = store.get(id);
          if (!c) return;
          if (c.type === 'code' && c.code?.kind === 'component') components.push({ name: c.code.title || c.name, storyId: c.code.storyId, file: c.code.file });
          else if (c.codeLink && (c.codeLink.storyId || c.codeLink.file)) components.push({ name: c.name, storyId: c.codeLink.storyId, file: c.codeLink.file });
          for (const k of c.children ?? []) walk(k);
        };
        walk(n.id);
        const pins = comments
          .map((c) => ({ c, a: editor.comments.anchor(c) }))
          .filter(({ c, a }) => (c.nodeId && store.get(c.nodeId) ? inside(c.nodeId, n.id) : a.x >= box.x && a.y >= box.y && a.x <= box.x + box.w && a.y <= box.y + box.h))
          .map(({ c, a }) => ({ id: c.id, x: Math.round(a.x - box.x), y: Math.round(a.y - box.y) }));
        return { id: n.id, name: n.name, w: box.w, h: box.h, svg: exportSVG(store, [n.id]), css: cssFor(store, n), components, pins };
      });
    },
    state: () => canvasState(store),
    context: () => selectionContext(store),
  };
  return host;
}

/** Live renders saved in the canvas get their address again once Storybook or the app is running. */
export async function reconnectLive(h: CanvasHost, running: { storybook?: string | null; app?: string | null }) {
  const store = h.editor.store;
  for (const id of store.allIds()) {
    const n = store.get(id);
    if (n?.type !== 'code' || !n.code || n.code.src) continue;
    try {
      if (n.code.kind === 'component' && n.code.storyId && running.storybook) n.code.src = (await api<{ src: string }>(`/api/story-src?id=${encodeURIComponent(n.code.storyId)}`)).src;
      if (n.code.kind === 'page' && n.code.url && running.app && new URL(n.code.url).origin === new URL(running.app).origin) n.code.src = (await api<{ src: string }>(`/api/preview?url=${encodeURIComponent(n.code.url)}`)).src;
    } catch {
      // Leave it as a placeholder; it reconnects next time the server runs.
    }
  }
  store.emit('doc');
}
