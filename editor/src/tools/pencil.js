// Pencil (Shift+P): freehand strokes, simplified and smoothed into a vector.

import * as G from '../core/geometry.js';
import { createVectorFromWorld } from './pen.js';

export class PencilTool {
  constructor(editor) {
    this.editor = editor;
    this.cursor = 'crosshair';
    this.points = null;
    this.width = 2;
    this.color = '#000000';
  }
  get store() { return this.editor.store; }

  onHover() { this.store.setHover(null); }

  onDown(e, p) {
    this.points = [p];
    this.store.setOverlay({ pencil: this.points, pencilWidth: this.width });
  }
  onMove(e, p) {
    if (!this.points) return;
    const last = this.points[this.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * this.store.view.zoom < 1.5) return;
    this.points.push(p);
    this.store.setOverlay({ pencil: this.points });
  }
  onUp() {
    const pts = this.points;
    this.points = null;
    this.store.setOverlay({ pencil: null });
    if (!pts || pts.length < 2) return;
    const simple = G.simplify(pts, 1.2 / this.store.view.zoom);
    const smooth = G.smoothPoints(simple);
    let id;
    this.store.transact(() => {
      const n = createVectorFromWorld(this.store, smooth, false, { strokeWidth: this.width, strokes: [{ type: 'solid', color: this.color, opacity: 1, visible: true }] });
      n.name = this.store.nextName('vector');
      id = n.id;
    });
    this.store.select([id]);
  }
}
