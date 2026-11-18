import { describe, expect, it } from 'vitest';
import { figmaStatus, parseOutline } from '../src/server/figma';
import { nodeIdFromLink } from '../src/web/components/FigmaImport';
import { fakeFigma } from './fixtures/fakeFigma';

const SELECTION = `<canvas id="0:1" name="Checkout">
  <frame id="12:34" name="Cart &amp; totals" x="0" y="0" width="1440.4" height="900">
    <text id="12:35" name="Title" x="24" y="24" width="200" height="32" />
    <instance id="12:36" name="Button" x="24" y="80" width="120" height="40" />
  </frame>
  <component-set id="40:1" name="Button" x="1600" y="0" width="400" height="200" />
</canvas>`;

describe('Figma desktop import', () => {
  it('reads the top-level nodes and the page name from the metadata outline', () => {
    const r = parseOutline(SELECTION);
    expect(r.pageName).toBe('Checkout');
    expect(r.nodes).toEqual([
      { id: '12:34', name: 'Cart & totals', type: 'frame', width: 1440, height: 900, children: 2 },
      { id: '40:1', name: 'Button', type: 'component-set', width: 400, height: 200, children: 0 },
    ]);
    expect(parseOutline('<frame id="1:2" name="Solo" width="10" height="20"/>').nodes.map((n) => n.id)).toEqual(['1:2']);
  });

  it('turns Figma links into node ids', () => {
    expect(nodeIdFromLink('https://www.figma.com/design/AbC123/My-file?node-id=12-34&t=x')).toBe('12:34');
    expect(nodeIdFromLink('https://www.figma.com/design/AbC123/My-file')).toBeNull();
    expect(nodeIdFromLink('5:6')).toBe('5:6');
    expect(nodeIdFromLink('nope')).toBeNull();
  });

  it('finds the server, keeps the session and lists the selection with thumbnails', async () => {
    const f = await fakeFigma({ selection: SELECTION });
    try {
      const { status, client } = await figmaStatus(['http://127.0.0.1:9/mcp', f.url]);
      expect(status.state).toBe('connected');
      expect(status.url).toBe(f.url);
      expect(status.server).toBe('Figma Dev Mode MCP 1.0.0');
      expect(status.selection?.map((s) => s.name)).toEqual(['Cart & totals', 'Button']);
      expect(await client!.screenshot('12:34')).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(parseOutline(await client!.metadata('7:8')).nodes[0]).toMatchObject({ id: '7:8', name: 'Linked' });
      expect(f.calls.slice(0, 3)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    } finally {
      await f.close();
    }
  });

  it('reports an empty selection without failing', async () => {
    const f = await fakeFigma({ selection: '' });
    try {
      const { status } = await figmaStatus([f.url]);
      expect(status.state).toBe('connected');
      expect(status.selection).toEqual([]);
      expect(status.detail).toMatch(/Nothing is selected/);
    } finally {
      await f.close();
    }
  });

  it('says Figma is not running when nothing listens', async () => {
    const { status } = await figmaStatus(['http://127.0.0.1:9/mcp']);
    expect(status.state).toBe('not-running');
  });
});
