// Hand (H, or hold Space, or middle mouse): pan the canvas.

export class HandTool {
  constructor(editor) {
    this.editor = editor;
    this.cursor = 'grab';
    this.drag = null;
  }
  onHover() { this.editor.store.setHover(null); }
  onDown(e) {
    const v = this.editor.store.view;
    this.drag = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y };
    this.cursor = 'grabbing';
  }
  onMove(e) {
    if (!this.drag) return;
    this.editor.store.setView({ x: this.drag.vx + e.clientX - this.drag.x, y: this.drag.vy + e.clientY - this.drag.y });
  }
  onUp() {
    this.drag = null;
    this.cursor = 'grab';
  }
}
