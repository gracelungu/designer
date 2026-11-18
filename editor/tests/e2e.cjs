// End-to-end checks for the canvas editor, driven like a designer would.
// Run: node editor/tests/e2e.cjs   (needs Playwright with Chromium)
// Set SHOTS=<dir> to save screenshots.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const results = [];
let page;
const errors = [];
async function check(name, fn) {
  const before = errors.length;
  try {
    await fn();
    if (errors.length > before) throw new Error('page error: ' + errors.slice(before).join(' | '));
    results.push(['PASS', name]);
    if (process.env.DUMP) console.log(name, '=>', await page.evaluate(() => { const s = window.designer.store; const d = (id) => { const n = s.get(id); return n.name + (n.children && n.children.length ? '[' + n.children.map(d).join(',') + ']' : ''); }; return s.doc.root.map(d).join(' | ') + '  tool=' + s.tool; }));
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]]);
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const S = (fn, arg) => page.evaluate(fn, arg);
const store = () => S(() => { const s = window.designer.store; return { sel: s.selection, tool: s.tool, nodes: s.doc.nodes, root: s.doc.root, comments: s.doc.comments, undo: s.undoStack.length }; });
const sel = async () => (await store()).sel.map((id) => null || id);
const node = (id) => S((i) => window.designer.store.get(i), id);
const toScreen = (p) => S((q) => { const e = window.designer; const r = e.rect(); const s = e.toScreen(q); return { x: s.x + r.left, y: s.y + r.top }; }, p);
const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') }); };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
async function drag(a, b, opts = {}) {
  await page.mouse.move(a.x, a.y);
  if (opts.down !== false) await page.mouse.down();
  const steps = opts.steps || 8;
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(60);
}
const canvasPoint = async (wx, wy) => toScreen({ x: wx, y: wy });
const press = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(40); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(800);
  await S(() => { window.designer.store.setView({ x: -200, y: 0, zoom: 1 }); });
  await page.waitForTimeout(100);

  let rectId;
  await check('R + drag draws a rectangle and returns to Move', async () => {
    await press('r');
    await drag(await canvasPoint(700, 300), await canvasPoint(820, 380));
    const s = await store();
    assert(s.tool === 'move', 'tool is ' + s.tool);
    rectId = s.sel[0];
    const n = s.nodes[rectId];
    assert(n && n.type === 'rect', 'no rect selected');
    assert(Math.abs(n.w - 120) < 2 && Math.abs(n.h - 80) < 2, `size ${n.w}x${n.h}`);
  });

  await check('Dragging moves the selection (whole pixels)', async () => {
    const n0 = await node(rectId);
    await drag(await canvasPoint(n0.x + 50, n0.y + 40), await canvasPoint(n0.x + 50 + 37.3, n0.y + 40 + 21.6));
    const n = await node(rectId);
    assert(Math.abs(n.x - n0.x - 37) <= 6 && Number.isInteger(n.x), `moved to ${n.x},${n.y}`);
  });

  await check('Corner handle resizes; Shift keeps proportions', async () => {
    const n0 = await node(rectId);
    await drag(await canvasPoint(n0.x + n0.w, n0.y + n0.h), await canvasPoint(n0.x + n0.w + 40, n0.y + n0.h + 10));
    let n = await node(rectId);
    assert(Math.abs(n.w - (n0.w + 40)) <= 6 && Math.abs(n.h - (n0.h + 10)) <= 6, `resized to ${n.w}x${n.h}`);
    const ratio = n.w / n.h;
    await page.keyboard.down('Shift');
    await drag(await canvasPoint(n.x + n.w, n.y + n.h), await canvasPoint(n.x + n.w + 60, n.y + n.h + 5));
    await page.keyboard.up('Shift');
    n = await node(rectId);
    assert(Math.abs(n.w / n.h - ratio) < 0.05, `ratio ${n.w / n.h} vs ${ratio}`);
  });

  await check('Rotate from just outside a corner', async () => {
    const n0 = await node(rectId);
    const c = await canvasPoint(n0.x + n0.w, n0.y);
    await drag({ x: c.x + 12, y: c.y - 12 }, { x: c.x + 60, y: c.y + 80 }, { steps: 12 });
    const n = await node(rectId);
    assert(Math.abs(n.rotation) > 5, 'rotation ' + n.rotation);
    await press(`${MOD}+z`);
    const back = await node(rectId);
    assert(Math.abs(back.rotation) < 0.01, 'undo rotation ' + back.rotation);
  });

  await check('Undo and redo', async () => {
    const s0 = await store();
    await press(`${MOD}+z`);
    const s1 = await store();
    await press(`${MOD}+Shift+z`);
    const s2 = await store();
    assert(JSON.stringify(s1.nodes[rectId]) !== JSON.stringify(s0.nodes[rectId]), 'undo did nothing');
    assert(JSON.stringify(s2.nodes[rectId]) === JSON.stringify(s0.nodes[rectId]), 'redo mismatch');
  });

  await check('O click creates a 100×100 ellipse', async () => {
    await press('o');
    const p = await canvasPoint(1000, 300);
    await page.mouse.click(p.x, p.y);
    const s = await store();
    const n = s.nodes[s.sel[0]];
    assert(n.type === 'ellipse' && n.w === 100 && n.h === 100, JSON.stringify([n.type, n.w, n.h]));
  });

  await check('Shift+click adds to selection, Cmd+G groups, Shift+Cmd+G ungroups', async () => {
    const r = await node(rectId);
    const p = await canvasPoint(r.x + 10, r.y + 10);
    await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Shift');
    let s = await store();
    assert(s.sel.length === 2, 'selection ' + s.sel.length);
    await press(`${MOD}+g`);
    s = await store();
    const g = s.nodes[s.sel[0]];
    assert(g.type === 'group' && g.children.length === 2, 'group ' + JSON.stringify(g && g.type));
    await press(`${MOD}+Shift+g`);
    s = await store();
    assert(s.sel.length === 2 && !s.nodes[g.id], 'ungroup');
  });

  await check('Marquee selects layers', async () => {
    await press('Escape');
    await drag(await canvasPoint(650, 250), await canvasPoint(1150, 450));
    const s = await store();
    assert(s.sel.length >= 2, 'marquee selected ' + s.sel.length);
  });

  await check('Align left with Alt+A', async () => {
    await press('Alt+a');
    const s = await store();
    const xs = await S((ids) => ids.map((id) => window.designer.store.worldBox(id).x), s.sel);
    assert(xs.every((x) => Math.abs(x - xs[0]) < 0.5), 'xs ' + xs);
  });

  await check('L draws a line, Shift+L an arrow', async () => {
    await press('Escape');
    await press('l');
    await drag(await canvasPoint(700, 520), await canvasPoint(850, 520));
    let s = await store();
    let n = s.nodes[s.sel[0]];
    assert(n.type === 'line' && Math.abs(n.w - 150) < 2, 'line ' + n.w);
    await press('Shift+l');
    await drag(await canvasPoint(700, 560), await canvasPoint(850, 620));
    s = await store();
    n = s.nodes[s.sel[0]];
    assert(n.type === 'arrow', 'arrow');
  });

  await check('Pen: click points and close the path', async () => {
    await press('p');
    for (const [x, y] of [[900, 520], [980, 520], [940, 600]]) {
      const q = await canvasPoint(x, y);
      await page.mouse.click(q.x, q.y);
      await page.waitForTimeout(250);
    }
    const q = await canvasPoint(900, 520);
    await page.mouse.click(q.x, q.y);
    const s = await store();
    const n = s.nodes[s.sel[0]];
    assert(n && n.type === 'vector' && n.closed && n.points.length === 3, 'vector ' + JSON.stringify(n && [n.type, n.closed, n.points?.length]));
  });

  await check('Pencil draws a smoothed vector', async () => {
    await press('Shift+p');
    await drag(await canvasPoint(1000, 520), await canvasPoint(1100, 600), { steps: 20 });
    const s = await store();
    const n = s.nodes[s.sel[0]];
    assert(n && n.type === 'vector' && !n.closed, 'pencil');
    await press('Escape');
  });

  await check('T: click, type, Escape creates text', async () => {
    await press('t');
    const q = await canvasPoint(700, 700);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(150);
    await page.keyboard.type('Hello Designer');
    await press('Escape');
    const s = await store();
    const n = s.nodes[s.sel[0]];
    assert(n && n.type === 'text' && n.text.content === 'Hello Designer', 'text ' + JSON.stringify(n && n.text));
    assert(n.w > 50, 'auto width ' + n.w);
  });

  let frameId;
  await check('F shows device presets; picking one adds a frame', async () => {
    await press('f');
    await page.waitForTimeout(100);
    const btn = page.locator('.dz-preset', { hasText: 'Phone SE' });
    assert(await btn.count() === 1, 'no preset list');
    await btn.click();
    const s = await store();
    const n = s.nodes[s.sel[0]];
    frameId = n.id;
    assert(n.type === 'frame' && n.w === 375 && n.h === 667, 'frame ' + n.w + 'x' + n.h);
  });

  await check('Dragging a layer into a frame reparents it', async () => {
    await S(() => window.designer.store.setView({ x: 50, y: 50, zoom: 0.5 }));
    await page.waitForTimeout(50);
    const f = await node(frameId);
    const r = await node(rectId);
    const from = await canvasPoint(r.x + r.w / 2, r.y + r.h / 2);
    await page.mouse.click(from.x, from.y);
    await drag(from, await canvasPoint(f.x + 100, f.y + 100), { steps: 12 });
    const n = await node(rectId);
    assert(n.parent === frameId, 'parent ' + n.parent + ' ' + JSON.stringify([f.x, f.y, f.w, r.x, r.y, n.x, n.y]));
  });

  await check('Shift+A adds auto layout to a frame', async () => {
    await S((id) => window.designer.store.select([id]), frameId);
    await press('Shift+a');
    const f = await node(frameId);
    assert(f.layout && f.layout.mode, 'layout ' + JSON.stringify(f.layout));
  });

  await check('Copy, paste and duplicate', async () => {
    await S((id) => window.designer.store.select([id]), rectId);
    const before = Object.keys((await store()).nodes).length;
    await press(`${MOD}+d`);
    let s = await store();
    assert(Object.keys(s.nodes).length === before + 1, 'duplicate');
    await press(`${MOD}+c`);
    await press(`${MOD}+v`);
    s = await store();
    assert(Object.keys(s.nodes).length === before + 2, 'paste ' + (Object.keys(s.nodes).length - before));
  });

  await check('Delete removes the selection', async () => {
    const before = Object.keys((await store()).nodes).length;
    await press('Delete');
    const s = await store();
    assert(Object.keys(s.nodes).length === before - 1 && !s.sel.length, 'delete');
  });

  await check('Properties panel: typing W resizes, fill hex recolours', async () => {
    await S((id) => window.designer.store.select([id]), rectId);
    await page.waitForTimeout(100);
    const w = page.locator('.dz-num', { has: page.locator('.dz-num-label', { hasText: /^W$/ }) }).locator('input');
    await w.fill('222');
    await w.press('Enter');
    let n = await node(rectId);
    assert(Math.abs(n.w - 222) < 0.01 || n.sizing.h !== 'fixed', 'w ' + n.w);
    const hex = page.locator('.dz-section', { hasText: 'Fill' }).locator('.dz-hex').first();
    await hex.fill('FF0055');
    await hex.press('Enter');
    await page.waitForTimeout(50);
    n = await node(rectId);
    assert(n.fills[0].color === '#FF0055', 'fill ' + n.fills[0].color);
  });

  await check('Add a drop shadow and a stroke from the panel', async () => {
    await page.locator('.dz-section', { hasText: 'Effects' }).locator('button[aria-label="Add effect"]').click();
    await page.locator('.dz-section', { hasText: 'Stroke' }).locator('button[aria-label="Add stroke"]').click();
    const n = await node(rectId);
    assert(n.effects.length === 1 && n.strokes.length === 1, JSON.stringify([n.effects.length, n.strokes.length]));
  });

  await check('Layers panel: click selects, double-click renames', async () => {
    const row = page.locator(`.dz-layer[data-id="${frameId}"]`);
    await row.click();
    let s = await store();
    assert(s.sel[0] === frameId, 'layer click');
    await row.locator('.dz-layer-name').dblclick();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type('Checkout');
    await page.keyboard.press('Enter');
    const f = await node(frameId);
    assert(f.name === 'Checkout', 'name ' + f.name);
  });

  await check('C pins a comment', async () => {
    await press('c');
    const q = await canvasPoint(1100, 150);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(100);
    await page.keyboard.type('Tighten this spacing');
    await page.keyboard.press('Enter');
    const s = await store();
    assert(s.comments.length === 1 && s.comments[0].text === 'Tighten this spacing', 'comments ' + s.comments.length);
    await press('Escape');
    await press('v');
  });

  await check('Comments pin to the frame under them and move with it', async () => {
    const ids = await S(() => {
      const st = window.designer.store;
      let f, r;
      st.transact(() => {
        f = st.create('frame', { x: 2000, y: 2000, w: 300, h: 200, name: 'Pin frame' });
        r = st.create('rect', { x: 2040, y: 2040, w: 100, h: 60, name: 'Inner rect' }, f.id);
      });
      window.designer.comments.author = 'Grace';
      window.designer.zoomToBox({ x: 1950, y: 1950, w: 400, h: 300 });
      return { f: f.id, r: r.id };
    });
    await page.waitForTimeout(50);
    await press('c');
    const q = await canvasPoint(2060, 2060);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(100);
    await page.keyboard.type('Pinned to the frame');
    await page.keyboard.press('Enter');
    const s = await store();
    const c = s.comments.find((x) => x.text === 'Pinned to the frame');
    assert(c && c.nodeId === ids.f, 'pinned to ' + (c && c.nodeId));
    assert(c.author === 'Grace', 'author ' + c.author);
    assert(await page.locator('.dz-thread .dz-on', { hasText: 'Pin frame' }).count() === 1, 'thread names the frame');
    await press('Escape');
    await press('v');
    await S((id) => { const st = window.designer.store; st.transact(() => st.moveBy(id, 100, 50)); }, ids.f);
    const a = await S((cid) => { const e = window.designer; return e.comments.anchor(e.store.doc.comments.find((x) => x.id === cid)); }, c.id);
    assert(Math.abs(a.x - 2160) < 1 && Math.abs(a.y - 2110) < 1, 'anchor ' + JSON.stringify(a));
  });

  await check('Opening a comment from a list shows its thread', async () => {
    await S(() => window.designer.zoomToBox({ x: 0, y: 0, w: 400, h: 300 }));
    const id = await S(() => { const e = window.designer; const c = e.store.doc.comments.find((x) => x.text === 'Pinned to the frame'); e.comments.open(c.id); return c.id; });
    await page.waitForTimeout(50);
    assert(await page.locator(`.dz-pin.on[data-comment="${id}"]`).count() === 1, 'pin open');
    const pin = await page.locator(`.dz-pin.on[data-comment="${id}"]`).boundingBox();
    const r = await S(() => { const b = window.designer.rect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });
    assert(pin.x > r.l && pin.x < r.l + r.w && pin.y > r.t && pin.y < r.t + r.h, 'pin in view');
    await S(() => { const e = window.designer; e.comments.close(); e.comments.showAlways = false; e.comments.render(); });
  });

  await check('Hand tool and Space pan; zoom shortcuts', async () => {
    const v0 = await S(() => ({ ...window.designer.store.view }));
    await press('h');
    await drag({ x: 700, y: 400 }, { x: 760, y: 450 });
    const v1 = await S(() => ({ ...window.designer.store.view }));
    assert(Math.abs(v1.x - v0.x - 60) < 2, 'pan ' + (v1.x - v0.x));
    await press('v');
    await press('Shift+0');
    const v2 = await S(() => ({ ...window.designer.store.view }));
    assert(v2.zoom === 1, 'zoom ' + v2.zoom);
    await press('Shift+1');
  });

  await check('Context menu opens with actions', async () => {
    const r = await node(rectId);
    const q = await canvasPoint(r.x + 5, r.y + 5);
    await page.mouse.click(q.x, q.y, { button: 'right' });
    await page.waitForTimeout(50);
    assert(await page.locator('.dz-menu').count() === 1, 'no menu');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 300);
  });

  await check('Toolbar dropdown switches to Star and draws it', async () => {
    await page.locator('.dz-tb-group').nth(2).locator('.dz-tb-more').click();
    await page.locator('.dz-menu-item', { hasText: 'Star' }).click();
    const s0 = await store();
    assert(s0.tool === 'star', 'tool ' + s0.tool);
    const vr = await S(() => window.designer.viewRect());
    await drag(await canvasPoint(vr.x + 40, vr.y + 40), await canvasPoint(vr.x + 40 + 60 / (vr.w / 960), vr.y + 40 + 60 / (vr.w / 960)));
    const s = await store();
    assert(s.nodes[s.sel[0]].type === 'star', 'star');
  });

  await shot('after-tests');
  await browser.close();
  server.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  for (const r of results) console.log(r.join('  '));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
