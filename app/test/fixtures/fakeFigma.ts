import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A stand-in for Figma's desktop MCP server: streamable HTTP, SSE replies, a session id. */
export async function fakeFigma(opts: { selection: string; tools?: string[]; variables?: string }): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const tools = opts.tools ?? ['get_design_context', 'get_metadata', 'get_screenshot', 'get_variable_defs'];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { nodeId?: string } } };
      calls.push(msg.method + (msg.params?.name ? `:${msg.params.name}` : ''));
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') {
        res.writeHead(400).end('no session');
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'Figma Dev Mode MCP', version: '1.0.0' }, capabilities: {} };
      if (msg.method === 'tools/list') result = { tools: tools.map((name) => ({ name })) };
      if (msg.method === 'tools/call' && msg.params?.name === 'get_metadata') {
        const id = msg.params.arguments?.nodeId;
        result = id
          ? { content: [{ type: 'text', text: `<frame id="${id}" name="Linked" x="0" y="0" width="320" height="200" />` }] }
          : opts.selection
            ? { content: [{ type: 'text', text: opts.selection }] }
            : { isError: true, content: [{ type: 'text', text: 'Nothing is selected' }] };
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'get_variable_defs')
        result = opts.variables ? { content: [{ type: 'text', text: opts.variables }] } : { isError: true, content: [{ type: 'text', text: 'Nothing is selected' }] };
      if (msg.method === 'tools/call' && msg.params?.name === 'get_screenshot') result = { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
