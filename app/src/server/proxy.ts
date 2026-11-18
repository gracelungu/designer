// A transparent proxy in front of the project's own dev servers (the app, Storybook).
// Each target gets its own loopback port, so the page's absolute paths and hot-reload sockets
// keep working; HTML responses get the probe script, and headers that forbid framing are dropped.
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { PROBE_JS } from './probe.js';

const PROBE_PATH = '/__designer_probe.js';
const PROBE_TAG = `<script src="${PROBE_PATH}"></script>`;

export function isLoopbackUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** Puts the probe as early as possible in the document, so it sees the page from its first render. */
export function injectProbe(html: string) {
  if (html.includes(PROBE_PATH)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + PROBE_TAG + html.slice(head.index + head[0].length);
  return PROBE_TAG + html;
}

const DROP = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-length', 'content-encoding', 'transfer-encoding']);

class Proxy {
  server: Server;
  port = 0;
  constructor(readonly target: URL) {
    this.server = createServer((req, res) => {
      if (req.url === PROBE_PATH) {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(PROBE_JS);
        return;
      }
      const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
      delete headers.origin;
      delete headers.referer;
      const up = request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (r: IncomingMessage) => {
        const type = String(r.headers['content-type'] ?? '');
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !DROP.has(k)) out[k] = v;
        if (typeof r.headers.location === 'string') out.location = r.headers.location.replace(target.origin, `http://127.0.0.1:${this.port}`);
        if (type.includes('text/html')) {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => {
            const body = injectProbe(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(r.statusCode ?? 200, { ...out, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
            res.end(body);
          });
          return;
        }
        if (r.headers['content-length']) out['content-length'] = r.headers['content-length'];
        res.writeHead(r.statusCode ?? 200, out);
        r.pipe(res);
      });
      up.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Designer could not reach ${target.origin}: ${e.message}`);
      });
      req.pipe(up);
    });
    // Hot reload sockets go straight through.
    this.server.on('upgrade', (req, socket, head) => {
      const upstream = connect(Number(target.port || 80), target.hostname, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i];
          lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : k.toLowerCase() === 'origin' ? target.origin : req.rawHeaders[i + 1]}`);
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  }
  listen() {
    return new Promise<void>((r) =>
      this.server.listen(0, '127.0.0.1', () => {
        const a = this.server.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        r();
      }),
    );
  }
}

/** One proxy per dev server origin, started on demand. */
export class PreviewProxies {
  private byOrigin = new Map<string, Proxy>();

  /** The proxied address of a URL on a local dev server. */
  async url(u: string): Promise<string> {
    if (!isLoopbackUrl(u)) throw new Error('Only local dev servers can be shown on the canvas.');
    const target = new URL(u);
    let p = this.byOrigin.get(target.origin);
    if (!p) {
      p = new Proxy(new URL(target.origin));
      await p.listen();
      this.byOrigin.set(target.origin, p);
    }
    return `http://127.0.0.1:${p.port}${target.pathname}${target.search}`;
  }

  closeAll() {
    for (const p of this.byOrigin.values()) p.server.close();
    this.byOrigin.clear();
  }
}
