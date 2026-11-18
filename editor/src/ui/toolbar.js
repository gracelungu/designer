// Bottom toolbar, grouped like Figma: move tools, region tools, shapes, drawing, text, comment.

import { h, showMenu, keyLabel } from './dom.js';
import { ICONS } from './icons.js';
import { TOOL_INFO } from '../editor.js';

const GROUPS = [
  { key: 'move', tools: ['move', 'hand', 'scale'] },
  { key: 'frame', tools: ['frame', 'section'] },
  { key: 'shape', tools: ['rect', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'image'] },
  { key: 'draw', tools: ['pen', 'pencil'] },
  { key: null, tools: ['text'] },
  { key: null, tools: ['comment'] },
];

export class Toolbar {
  constructor(editor, el, { onAskAI } = {}) {
    this.editor = editor;
    this.el = el;
    this.onAskAI = onAskAI;
    el.className = 'dz-toolbar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Tools');
    this.build();
    editor.store.on((ch) => { if (ch.has('tool') || ch.has('doc')) this.update(); });
  }

  pick(id) {
    if (id === 'image') { this.editor.pickImages(); return; }
    this.editor.setTool(id);
  }

  build() {
    this.el.innerHTML = '';
    this.buttons = [];
    for (const g of GROUPS) {
      const wrap = h('div', { class: 'dz-tb-group' });
      const main = h('button', { class: 'dz-tb-btn', 'data-group': g.key || g.tools[0] });
      main.addEventListener('click', () => {
        const id = g.key ? this.editor.lastUsed[g.key] : g.tools[0];
        this.pick(id);
      });
      wrap.append(main);
      if (g.tools.length > 1) {
        const more = h('button', { class: 'dz-tb-more', 'aria-label': 'More tools', html: ICONS.chevron });
        more.addEventListener('click', () => {
          const r = wrap.getBoundingClientRect();
          showMenu(g.tools.map((t) => ({
            label: TOOL_INFO[t].label, icon: ICONS[t], shortcut: TOOL_INFO[t].key,
            checked: this.editor.store.tool === t,
            action: () => this.pick(t),
          })), r.left, r.top, { anchor: 'above', className: 'dz-menu-dark' });
        });
        wrap.append(more);
      }
      this.buttons.push({ g, main, wrap });
      this.el.append(wrap);
    }
    this.el.append(h('span', { class: 'dz-tb-sep' }));
    const ai = h('button', { class: 'dz-tb-ai', title: 'Ask AI about the selection (K in the workspace)', html: `${ICONS.ai}<span>Ask AI</span>` });
    ai.addEventListener('click', () => this.onAskAI && this.onAskAI(ai));
    this.el.append(ai);
    this.update();
  }

  update() {
    const tool = this.editor.store.tool;
    for (const { g, main } of this.buttons) {
      const shown = g.key ? (g.tools.includes(tool) ? tool : this.editor.lastUsed[g.key]) : g.tools[0];
      const info = TOOL_INFO[shown];
      main.innerHTML = ICONS[shown];
      const active = g.tools.includes(tool);
      main.classList.toggle('on', active);
      main.title = `${info.label}${info.key ? ' (' + keyLabel(info.key.replace('⌘', 'Mod')) + ')' : ''}`;
      main.setAttribute('aria-label', info.label);
      main.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
}
