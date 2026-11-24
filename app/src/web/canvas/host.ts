// Creates the canvas editor once, with its toolbar, layers and properties panels, so React can
// place those panels in the app's own sidebars without remounting them.
import { bindShortcuts, cssFor, emptyDoc, Editor, exportSVG, LayersPanel, PropertiesPanel, Toolbar } from '../../../../editor/src/index.js';
import { componentKey, type CanvasComment, type CanvasOp, type ComponentEntry, type ComponentSource, type PreviewFrame } from '../../shared/protocol';
import { api } from '../api';
import { buildNodes, canvasState, freeSpot, placeAt, selectionContext, storyIds, applySimple } from './convert';

export interface CanvasHost {
  editor: Editor;
  stage: HTMLDivElement;
  layersEl: HTMLDivElement;
  propsEl: HTMLDivElement;
  /** Loads the canvas saved for the open project (or Designer's own folder). */
  load(): Promise<void>;
  /** Finish saving the current canvas before switching projects. */
  flush(): Promise<void>;
  canSync(): boolean;
  apply(op: CanvasOp): Promise<unknown>;
  placeComponent(project: string, component: ComponentEntry, nextToSelection?: boolean): Promise<string>;
  reconnectComponents(): void;
  placeStory(storyId: string, opts?: { nextToSelection?: boolean; title?: string; file?: string; args?: Record<string, unknown> }): Promise<string>;
  showPage(url: string, name?: string): Promise<string>;
  state(): ReturnType<typeof canvasState>;
  /** Renders a story out of sight and resolves with the styles its probe reports. */
  measureStory(storyId: string, timeoutMs?: number): Promise<Record<string, string>>;
  /** Reloads every live component and page frame, so they show code that just changed. */
  reloadLive(): void;
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
  let loadId = 0;
  let savedComments = '[]';
  let saving = Promise.resolve<unknown>(undefined);
  let savingComments = Promise.resolve<unknown>(undefined);
  let commentsScheduled = '[]';
  const saveComments = () => {
    const next = JSON.stringify(store.doc.comments ?? []);
    if (next === commentsScheduled) return;
    commentsScheduled = next;
    savingComments = savingComments.catch(() => undefined).then(async () => {
      if (next !== savedComments) {
        await api('/api/comments', { comments: JSON.parse(next) });
        savedComments = next;
      }
    }).catch((error) => {
      if (commentsScheduled === next) commentsScheduled = savedComments;
      throw error;
    });
    void savingComments.catch(() => undefined);
  };
  const saveCanvas = async () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const data = structuredClone({ version: 1, doc: store.doc, assets: store.assets });
    saving = saving.catch(() => undefined).then(() => api('/api/canvas', { data }));
    await saving;
  };
  store.on((ch) => {
    if (!ch.has('commit') || loading) return;
    saveComments();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveCanvas().catch(() => undefined), 600);
  });

  const storySrc = async (ids: Iterable<string>) => {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = (await api<{ src: string }>(`/api/story-src?id=${encodeURIComponent(id)}`)).src;
    return out;
  };

  let canvasProject: string | undefined;
  const sourceUrl = (project: string, source: ComponentSource, rebuild = false) =>
    api<{ src: string }>('/api/components/preview', { project, ...source, rebuild });

  const reconnectComponents = (rebuild = false) => {
    const project = canvasProject;
    if (!project) return;
    const generation = loadId;
    const sources = new Map<string, { source: ComponentSource; ids: string[] }>();
    for (const id of store.allIds()) {
      const code = store.get(id)?.code;
      if (!code?.source || (!rebuild && code.src)) continue;
      const key = componentKey(code.source);
      if (!sources.has(key)) sources.set(key, { source: code.source, ids: [] });
      sources.get(key)!.ids.push(id);
    }
    void (async () => {
      for (const { source, ids } of sources.values()) {
        if (generation !== loadId) return;
        try {
          const { src } = await sourceUrl(project, source, rebuild);
          if (generation !== loadId) return;
          for (const id of ids) {
            const node = store.get(id);
            if (!node?.code?.source || componentKey(node.code.source) !== componentKey(source)) continue;
            const frame = editor.code.frames.get(id);
            if (node.code.src === src && !rebuild) continue;
            if (node.code.src === src && frame) frame.iframe.src = src;
            node.code.src = src;
          }
          store.emit('doc');
        } catch {
          // A deleted or unbuildable source stays on the canvas as a linked placeholder.
        }
      }
    })();
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
    async flush() {
      if (loading) throw new Error('Wait for the canvas to open.');
      store.flush();
      saveComments();
      await Promise.all([saveTimer ? saveCanvas() : saving, savingComments]);
    },
    canSync: () => !loading && !store.pending && !store.editingText,
    async load() {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      loading = true;
      const id = ++loadId;
      try {
        const r = await api<{ project?: string; data: { doc?: { comments?: unknown[] }; assets?: Record<string, string> } | null; comments?: CanvasComment[]; author?: string }>('/api/canvas').catch(() => ({ data: null, comments: [] as CanvasComment[], author: undefined, project: undefined }));
        if (id !== loadId) return;
        canvasProject = r.project;
        const data = r.data;
        if (data && data.doc) store.load(data.doc, data.assets ?? {});
        else store.load(emptyDoc(), {});
        store.doc.comments = r.comments ?? [];
        savedComments = commentsScheduled = JSON.stringify(store.doc.comments);
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
        reconnectComponents();
        requestAnimationFrame(() => (store.doc.root.length ? editor.zoomToFit() : undefined));
      } finally {
        if (id === loadId) loading = false;
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
        case 'show-source-component':
          for (let i = 0; loading && i < 50; i++) await new Promise((done) => setTimeout(done, 100));
          return { id: await host!.placeComponent(op.project, op.component, op.nextToSelection) };
        case 'show-component':
          return { id: await host!.placeStory(op.storyId, { nextToSelection: op.nextToSelection, title: op.title, file: op.file, args: op.args }) };
        case 'show-page':
          return { id: await host!.showPage(op.url, op.name) };
        case 'select':
          focusOn(op.ids);
          return { selected: op.ids };
      }
    },
    async placeComponent(project, component, nextToSelection = false) {
      if (loading || canvasProject !== project) throw new Error('Wait for the project canvas to open.');
      const generation = loadId;
      const source = { file: component.file, exportName: component.exportName };
      const { src } = await sourceUrl(project, source, true);
      if (generation !== loadId) throw new Error('The active canvas changed.');
      const id = store.transact(() => {
        const existing = !nextToSelection && store.allIds().map((id) => store.get(id)!).find((node) =>
          node.code?.source && componentKey(node.code.source) === componentKey(source));
        if (existing && existing.code) {
          const frame = editor.code.frames.get(existing.id);
          if (existing.code.src === src && frame) frame.iframe.src = src;
          existing.code.src = src;
          return existing.id;
        }
        const spot = freeSpot(store, nextToSelection || store.selection.length > 0);
        const node = store.create('code', { x: spot.x, y: spot.y, name: component.name });
        node.code = { kind: 'component', src, title: component.name, hug: true, args: {}, source, file: source.file };
        return node.id;
      });
      focusOn([id]);
      return id;
    },
    reconnectComponents,
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
      const address = new URL(url).href;
      const existing = store.allIds().map((id) => store.get(id)!).find((n) => n.type === 'code' && n.code?.kind === 'page' && n.code.url && n.code.url === address);
      if (existing?.code) {
        existing.code.src = src;
        store.emit('doc');
        return existing.id;
      }
      const id = store.transact(() => {
        const spot = freeSpot(store, false);
        const n = store.create('code', { x: spot.x, y: spot.y, w: 1280, h: 800, name: name ?? `App · ${new URL(url).pathname}` });
        n.code = { kind: 'page', src, url: address, title: n.name, hug: false, args: {} };
        return n.id;
      });
      focusOn([id]);
      return id;
    },
    comments: () => (store.doc.comments ?? []) as CanvasComment[],
    setComments(list) {
      const next = JSON.stringify(list);
      if (next === JSON.stringify(store.doc.comments ?? [])) return;
      savedComments = commentsScheduled = next;
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
    async measureStory(storyId, timeoutMs = 20000) {
      const { src } = await api<{ src: string }>(`/api/story-src?id=${encodeURIComponent(storyId)}&start=false`);
      return new Promise<Record<string, string>>((resolve, reject) => {
        const f = document.createElement('iframe');
        f.setAttribute('aria-hidden', 'true');
        f.tabIndex = -1;
        f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;visibility:hidden;pointer-events:none;border:0';
        let settle: ReturnType<typeof setTimeout> | undefined;
        let last: Record<string, string> | undefined;
        const end = (err?: Error) => {
          clearTimeout(settle);
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          f.remove();
          if (last && !err) resolve(last);
          else reject(err ?? new Error('The component did not render.'));
        };
        const onMsg = (e: MessageEvent) => {
          const d = e.data as { source?: string; type?: string; styles?: Record<string, string>; message?: string };
          if (e.source !== f.contentWindow || d?.source !== 'designer-probe') return;
          if (d.type === 'styles' && d.styles) {
            last = d.styles;
            // Wait for it to stop changing (fonts, late renders).
            clearTimeout(settle);
            settle = setTimeout(() => end(), 500);
          } else if (d.type === 'error') end(new Error(d.message ?? 'The component failed to render.'));
        };
        const timer = setTimeout(() => end(last ? undefined : new Error('The component took too long to render.')), timeoutMs);
        window.addEventListener('message', onMsg);
        f.src = src;
        document.body.append(f);
      });
    },
    reloadLive() {
      reconnectComponents(true);
      for (const [id, fr] of editor.code.frames) {
        const n = store.get(id);
        if (n?.type === 'code' && n.code?.src && !n.code.source) fr.iframe.src = n.code.src;
      }
    },
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
