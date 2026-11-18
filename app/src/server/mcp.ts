// Designer's own tools for Claude, served as a small MCP server (streamable HTTP, JSON responses)
// on Designer's local port. They let Claude open a project the user mentions, run it, read the
// canvas, and put designs and live components on it.

export interface ToolHost {
  openProject(path: string): Promise<string>;
  runProject(command: string | undefined, kind: 'app' | 'storybook'): Promise<string>;
  canvasState(): unknown;
  addNodes(nodes: unknown[], nextToSelection: boolean): Promise<unknown>;
  updateNodes(updates: unknown[]): Promise<unknown>;
  showComponent(storyId: string, args: Record<string, unknown> | undefined, nextToSelection: boolean): Promise<string>;
  designTokens(status?: string): Promise<unknown>;
  /** Comments pinned on the canvas, as text. */
  comments?(includeResolved: boolean): Promise<string>;
  replyToComment?(id: string, text: string, resolve: boolean | undefined): Promise<string>;
}

const NODE_SCHEMA = {
  type: 'object',
  description:
    'A layer. x/y of top-level layers are canvas pixels; x/y of children are relative to their parent (like Figma). In a frame with layout, auto layout places the children and their x/y are ignored.',
  properties: {
    type: { type: 'string', enum: ['frame', 'group', 'rect', 'ellipse', 'line', 'text', 'image', 'component'] },
    name: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    fill: { type: 'string', description: 'Hex colour like #RRGGBB or #RRGGBBAA' },
    stroke: { type: 'string' },
    strokeWidth: { type: 'number' },
    radius: { description: 'Corner radius, or [topLeft, topRight, bottomRight, bottomLeft]' },
    opacity: { type: 'number' },
    rotation: { type: 'number' },
    clip: { type: 'boolean' },
    shadow: { type: 'object', description: '{ x, y, blur, spread, color, opacity }' },
    text: { type: 'object', description: '{ content, fontFamily, fontSize, fontWeight, color, align, lineHeight (px), letterSpacing (%), italic }' },
    layout: { type: 'object', description: 'Auto layout: { mode: horizontal|vertical, gap, padding (number or [t,r,b,l]), align: start|center|end|space-between, counterAlign: start|center|end|stretch }' },
    sizing: { type: 'object', description: '{ h: fixed|hug|fill, v: fixed|hug|fill }' },
    imageUrl: { type: 'string', description: 'For image layers: an http(s) or data: URL' },
    storyId: { type: 'string', description: 'For component layers: the Storybook story id to render live from code' },
    args: { type: 'object', description: 'For component layers: props to render the story with' },
    codeLink: { type: 'object', description: 'Links a design layer to its coded component: { storyId, file, exportName }' },
    children: { type: 'array', items: { type: 'object' } },
  },
  required: ['type'],
};

export const TOOLS = [
  {
    name: 'open_project',
    description:
      "Open a folder on this computer as the Designer project: the repository the canvas, Components list, tokens and git buttons work on. Use it when the user names or points to a project (a path, a repo name in their dev folder, or 'the app I cloned'). Find the folder first if needed, for example with ls or find.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the project folder' } }, required: ['path'] },
  },
  {
    name: 'run_project',
    description:
      "Start the open project's dev server (kind app) or its Storybook (kind storybook) with a shell command, wait for the local URL it prints, and show it on the canvas. Work out the right command from the repo (package.json scripts, README, Makefile, framework); install dependencies first if they are missing. Returns the URL, or the server's last log lines if it failed.",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: "Shell command run in the project folder, e.g. 'npm run dev', 'pnpm storybook', 'bin/dev'" },
        kind: { type: 'string', enum: ['app', 'storybook'] },
      },
      required: ['command', 'kind'],
    },
  },
  {
    name: 'get_canvas',
    description: 'Read the Designer canvas: the layers the user has selected (in full) and every top-level layer (in brief). Use it when the user says "this", "the selection", or refers to something on the canvas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_canvas',
    description:
      'Add editable design layers to the canvas, for example a screen you read from Figma with the figma MCP server, or a new layout you sketch. Use real values from the design (sizes, colours, fonts, spacing). Frames with auto layout keep their children in order. To show a coded component from this repo instead of drawing it, use show_component.',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: { type: 'array', items: NODE_SCHEMA },
        nextToSelection: { type: 'boolean', description: 'Place the new layers to the right of the current selection instead of where they say' },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'update_layers',
    description: 'Change existing canvas layers by id (ids come from get_canvas). Each update takes the same fields as add_to_canvas layers; only the fields given change.',
    inputSchema: { type: 'object', properties: { updates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }, required: ['updates'] },
  },
  {
    name: 'show_component',
    description:
      "Place one coded component from this repo on the canvas, rendered live from code as a design layer (no Storybook UI), sized to its content. Identify it by Storybook story id (e.g. 'components-button--primary'). Starts Storybook if it isn't running. Use nextToSelection to put it beside a design for comparison.",
    inputSchema: {
      type: 'object',
      properties: {
        storyId: { type: 'string' },
        args: { type: 'object', description: 'Props to render it with' },
        nextToSelection: { type: 'boolean' },
      },
      required: ['storyId'],
    },
  },
  {
    name: 'get_design_tokens',
    description:
      "The project's design tokens (CSS custom properties and Tailwind theme values) paired with the Figma variables pulled into the project, and whether each pair is in sync, has drifted, or exists on one side only. Use it before styling anything, to use tokens instead of raw values, and when the user asks to fix drift between Figma and code.",
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['in-sync', 'drift', 'figma-only', 'code-only'], description: 'Only pairs with this status' } } },
  },
  {
    name: 'get_comments',
    description:
      'Read the comments people pinned on the canvas (the team adds them in Designer, and they sync through git). Each has a number, the frame it is on, its text and replies. Use it when the user mentions comments or feedback, or asks you to address them.',
    inputSchema: { type: 'object', properties: { includeResolved: { type: 'boolean' } } },
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to a canvas comment (by id or number, from get_comments), for example to say what you changed. Set resolve true once the comment is addressed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, resolve: { type: 'boolean' } }, required: ['id'] },
  },
];

type Rpc = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };

/** Answers one JSON-RPC message (or batch). Returns null for notifications. */
export async function handleMcp(body: unknown, host: ToolHost): Promise<unknown> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleMcp(b, host)))).filter((x) => x !== null);
    return out.length ? out : null;
  }
  const m = body as Rpc;
  if (m.id === undefined || m.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'designer', version: '0.2.0' },
        instructions: 'Designer is the app the user is talking to you from. These tools act on its canvas and on the project it has open.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const a = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await callTool(name, a, host);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } };
  }
}

async function callTool(name: string, a: Record<string, unknown>, host: ToolHost): Promise<string> {
  const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  switch (name) {
    case 'open_project':
      return host.openProject(String(a.path ?? ''));
    case 'run_project':
      return host.runProject(a.command ? String(a.command) : undefined, a.kind === 'storybook' ? 'storybook' : 'app');
    case 'get_canvas':
      return json(host.canvasState() ?? { selection: [], layers: [], note: 'The canvas has not reported yet.' });
    case 'add_to_canvas':
      return json(await host.addNodes(Array.isArray(a.nodes) ? a.nodes : [], !!a.nextToSelection));
    case 'update_layers':
      return json(await host.updateNodes(Array.isArray(a.updates) ? a.updates : []));
    case 'show_component':
      return host.showComponent(String(a.storyId ?? ''), a.args as Record<string, unknown> | undefined, !!a.nextToSelection);
    case 'get_design_tokens':
      return json(await host.designTokens(a.status ? String(a.status) : undefined));
    case 'get_comments':
      if (!host.comments) throw new Error('Comments are not available.');
      return host.comments(!!a.includeResolved);
    case 'reply_to_comment':
      if (!host.replyToComment) throw new Error('Comments are not available.');
      return host.replyToComment(String(a.id ?? ''), String(a.text ?? ''), typeof a.resolve === 'boolean' ? a.resolve : undefined);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export const SYSTEM_PROMPT = `You are running inside Designer, a Figma-like canvas app that sits on top of the user's code. The user is often a designer: explain in plain words, keep git jargon out unless asked, and show your work on the canvas when it helps.

Designer gives you tools (the "designer" MCP server):
- open_project: when the user mentions a project or folder, find it on disk and open it. If no project is open and the request needs one, ask which project, or look in common places (~/dev, ~/code, ~/Projects, ~/src) for a match.
- run_project: work out how the project runs (package.json scripts, README, framework) and start it; install dependencies first if needed. Use kind "storybook" for the component previews.
- get_canvas: read what the user has selected on the canvas.
- add_to_canvas / update_layers: put editable design layers on the canvas (for example a frame you read from Figma with the figma MCP server, or a layout from scratch). Use real values and auto layout.
- get_design_tokens: the repo's tokens paired with the Figma variables, with drift. Style with these tokens, never raw values when a token exists. When code and Figma disagree, Figma is the design source unless the user says otherwise.
- get_comments / reply_to_comment: read the comments the team pinned on canvas frames, and answer or resolve them when you address them.
- show_component: render one coded component (by Storybook story id) on the canvas as a design layer, live from code, so it can sit next to its Figma design and look identical.

When a coded component should match a design: read the design (Figma MCP or get_canvas), use the repo's own tokens and components, then show_component next to the design and compare. If the project has no Storybook stories for a component, write a CSF3 story for it (one story per variant), so Designer can render it on the canvas.`;
