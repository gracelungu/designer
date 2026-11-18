import type { ClientMessage, ServerMessage } from '../shared/protocol';

declare global {
  interface Window {
    __DESIGNER_TOKEN__?: string;
    designerNative?: { pickFolder(): Promise<string | null>; openExternal(url: string): void; isElectron: true };
  }
}
declare const __DEV_TOKEN__: string;

const token = () => window.__DESIGNER_TOKEN__ || __DEV_TOKEN__;

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-designer-token': token(), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

type Listener = (m: ServerMessage) => void;

export class Socket {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private queue: string[] = [];
  connected = false;
  onStatus?: (connected: boolean) => void;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onStatus?.(true);
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      for (const l of this.listeners) l(m);
    };
  }

  send(m: ClientMessage) {
    const data = JSON.stringify(m);
    if (this.connected && this.ws) this.ws.send(data);
    else this.queue.push(data);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const socket = new Socket();

/** Address of one before/after/diff image of a visual review (images can't send the token header). */
export function reviewImage(id: string, file: string, bust = '') {
  return `/api/review-image?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}&token=${encodeURIComponent(token())}${bust ? `&v=${bust}` : ''}`;
}
