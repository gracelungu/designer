// Runs the two-way sync for the open canvas: sends canvas edits on linked layers to Claude Code,
// holds the code change it proposes for review, and brings linked layers up to date when code changes.
import { exportSVG, type EditorNode, type Store } from '../../../../editor/src/index.js';
import type { CodeChange, DesignChange, LayerSync, ProposalScope, SyncJob } from '../../shared/protocol';
import { acceptChanges, applySnap, ensureBaselines, filesFor, isLinked, labelFor, measurableLayers, mergeFromCode, pendingChanges, snapshot, stylesToSnap, syncOf, type IncomingChange, type Snap } from './model';

export interface SyncDeps {
  store: Store;
  /** Renders a story out of sight and returns its rendered styles. */
  measure: (storyId: string) => Promise<Record<string, string>>;
  /** Reloads live component frames, so they show the new code. */
  reloadLive: () => void;
  api: <T>(path: string, body?: unknown) => Promise<T>;
  /** How long to give Storybook to rebuild after code changed. */
  settleMs?: number;
}

/** A code change that reached a layer: what was applied, and what waits for a decision. */
export interface CodeUpdate {
  id: string;
  layerId: string;
  name: string;
  at: number;
  applied: DesignChange[];
  conflicts: IncomingChange[];
  files: string[];
  error?: string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SyncController {
  jobs = new Map<string, SyncJob>();
  updates: CodeUpdate[] = [];
  /** Code is being checked against the canvas after a pull. */
  checking = false;
  private listeners = new Set<() => void>();
  private version = 0;
  private n = 0;
  private project: string | null = null;
  private generation = 0;

  constructor(private readonly d: SyncDeps) {
    // Every canvas change can make an edit pending (or not), and new links need a baseline.
    d.store.on((ch) => {
      if (!ch.has('commit') && !ch.has('doc')) return;
      if (!this.track()) this.changed();
    });
  }

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  /** Changes whenever anything shown by the sync panel changes (for useSyncExternalStore). */
  snapshotVersion = () => this.version;
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get store() {
    return this.d.store;
  }

  /** Canvas edits not in code yet. */
  pending(): LayerSync[] {
    return pendingChanges(this.store);
  }

  /** Called on every canvas commit: new links get their baseline (and a measure of the code they show). */
  track() {
    const made = ensureBaselines(this.store);
    for (const id of made) void this.recordCode(id);
    if (made.length) this.changed();
    return made.length > 0;
  }

  /** Remembers how the linked component renders now, so later code changes can be told apart from design edits. */
  async recordCode(layerId: string) {
    const n = this.store.get(layerId);
    if (!n || n.type === 'code' || !n.codeLink?.storyId) return;
    try {
      const link = n.codeLink;
      const code = stylesToSnap(await this.d.measure(link.storyId!));
      if (this.store.get(layerId) !== n || n.codeLink !== link) return;
      this.store.transact(() => { n.sync = { ...syncOf(n), code }; });
    } catch {
      // Storybook isn't running; the first code change will ask instead of merging.
    }
  }

  recordUnmeasured() {
    for (const n of measurableLayers(this.store)) {
      if (!syncOf(n).code) void this.recordCode(n.id);
    }
  }

  active() {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'review').sort((a, b) => b.createdAt - a.createdAt);
  }

  async openProject(project: string | null) {
    if (this.project === project) return;
    this.project = project;
    const generation = ++this.generation;
    this.jobs.clear();
    this.updates = [];
    this.checking = false;
    this.changed();
    if (!project) return;
    const list = await this.d.api<SyncJob[]>('/api/sync').catch(() => []);
    if (generation !== this.generation) return;
    for (const job of list) {
      if (job.project === project && !this.jobs.has(job.id)) this.jobs.set(job.id, job);
    }
    this.changed();
  }

  onJob(job: SyncJob) {
    if (job.project && job.project !== this.project) return false;
    this.jobs.set(job.id, job);
    this.changed();
    return true;
  }

  /** Sends canvas edits (all pending layers, or the ones given) to Claude Code. */
  async sendToCode(layerIds?: string[], scopes: Record<string, { scope: ProposalScope; token?: string }> = {}) {
    const layers = this.pending().filter((l) => !layerIds || layerIds.includes(l.layerId))
      .map((l) => ({ ...l, ...scopes[l.layerId] }));
    if (!layers.length) throw new Error('There are no canvas changes to send to code.');
    const designIds = layers.filter((layer) => layer.kind === 'design').map((layer) => layer.layerId);
    const targetSvg = designIds.length ? exportSVG(this.store, designIds) : undefined;
    const job = await this.d.api<SyncJob>('/api/sync/to-code', { layers, targetSvg });
    this.onJob(job);
    return job;
  }

  async verify(id: string) {
    const job = await this.d.api<SyncJob>('/api/sync/verify', { id });
    this.onJob(job);
    return job;
  }

  /** Keeps Claude's code change: what it was asked to do becomes the new common ground. */
  async keep(id: string) {
    const job = await this.d.api<SyncJob>('/api/sync/keep', { id });
    if (!this.onJob(job)) return job;
    this.store.transact(() => acceptChanges(this.store, job.layers));
    // Once Storybook has rebuilt, remember how the code renders now.
    const generation = this.generation;
    void wait(this.d.settleMs ?? 1500).then(async () => {
      if (generation !== this.generation) return;
      this.d.reloadLive();
      for (const l of job.layers) await this.recordCode(l.layerId);
    });
    return job;
  }

  /** Puts the files back; the canvas edits stay pending. */
  async discard(id: string) {
    const job = await this.d.api<SyncJob>('/api/sync/discard', { id });
    this.onJob(job);
    return job;
  }

  markImplemented(layer: LayerSync) {
    this.store.transact(() => acceptChanges(this.store, [layer]));
    void this.recordCode(layer.layerId);
  }

  /** Puts a layer back the way it was when it last matched the code. */
  revert(layerId: string) {
    const n = this.store.get(layerId);
    const base = n && syncOf(n).base;
    if (!n || !base) return;
    this.store.transact(() => applySnap(this.store, n, base));
    this.changed();
  }

  /** Code moved under the canvas (a pull, a commit): reload live renders and update linked design layers. */
  async onCodeChanged(change: CodeChange) {
    this.d.reloadLive();
    const generation = this.generation;
    const layers = measurableLayers(this.store);
    if (!layers.length) return [];
    this.checking = true;
    this.changed();
    const out: CodeUpdate[] = [];
    try {
      await wait(this.d.settleMs ?? 1500);
      for (const n of layers) {
        if (generation !== this.generation) break;
        const u = await this.updateFromCode(n, change, generation).catch((e: Error) => {
          if (generation === this.generation && this.store.get(n.id) === n) return this.update(n, [], [], change.files, e.message);
        });
        if (u) out.push(u);
      }
    } finally {
      if (generation === this.generation) {
        this.checking = false;
        this.changed();
      }
    }
    return out;
  }

  private update(n: EditorNode, applied: DesignChange[], conflicts: IncomingChange[], files: string[], error?: string): CodeUpdate {
    const u: CodeUpdate = { id: `u${++this.n}`, layerId: n.id, name: n.name, at: Date.now(), applied, conflicts, files: filesFor(n, files), ...(error && { error }) };
    this.updates = [u, ...this.updates.filter((x) => x.layerId !== n.id)].slice(0, 30);
    return u;
  }

  private async updateFromCode(n: EditorNode, change: CodeChange, generation: number): Promise<CodeUpdate | null> {
    const link = n.codeLink;
    const codeAfter = stylesToSnap(await this.d.measure(link!.storyId!));
    if (generation !== this.generation || this.store.get(n.id) !== n || n.codeLink !== link) return null;
    const rec = syncOf(n);
    const current = snapshot(this.store, n);
    const { apply, conflicts } = mergeFromCode({ base: rec.base, current, codeBefore: rec.code, codeAfter });
    const applied: DesignChange[] = Object.entries(apply).map(([prop, to]) => ({ prop, label: labelFor(prop), from: current[prop] ?? null, to }));
    this.store.transact(() => {
      if (Object.keys(apply).length) applySnap(this.store, n, apply);
      // The layer now matches the code wherever it took the code's value.
      const base: Snap = { ...(rec.base ?? {}), ...apply };
      n.sync = { ...syncOf(n), base, code: codeAfter, incoming: conflicts.length ? { to: change.to, changes: conflicts } : undefined };
    });
    if (!applied.length && !conflicts.length) return null;
    return this.update(n, applied, conflicts, change.files);
  }

  /** Layers with code changes waiting for a decision. */
  incoming() {
    return this.store.allIds().map((id) => this.store.get(id)!)
      .filter((n) => isLinked(n) && syncOf(n).incoming?.changes.length);
  }

  /** Settles a code change that met a canvas edit: take the code's value, or keep the design's (and send it to code later). */
  resolve(layerId: string, take: 'code' | 'design', prop?: string) {
    const n = this.store.get(layerId);
    const inc = n && syncOf(n).incoming;
    if (!n || !inc) return;
    const chosen = inc.changes.filter((c) => !prop || c.prop === prop);
    this.store.transact(() => {
      const base = { ...(syncOf(n).base ?? {}) };
      if (take === 'code') {
        const patch = Object.fromEntries(chosen.map((c) => [c.prop, c.code]));
        applySnap(this.store, n, patch);
        Object.assign(base, patch);
      } else {
        // The code's value is the common ground now, so the design's value shows as a canvas edit to send.
        for (const c of chosen) base[c.prop] = c.code;
      }
      const left = inc.changes.filter((c) => !chosen.includes(c));
      n.sync = { ...syncOf(n), base, incoming: left.length ? { ...inc, changes: left } : undefined };
    });
    this.changed();
  }
}
