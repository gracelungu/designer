// The project's token report (Figma variables paired with code tokens), shared by the Tokens
// tab, the properties panel and the drift badges. It reloads when tokens can have changed.
import { useEffect, useState } from 'react';
import type { TokenReport } from '../shared/tokenSync';
import { api, socket } from './api';

let report: TokenReport | null = null;
let error = '';
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function tokenState() {
  return { report, error };
}

export function setReport(r: TokenReport | null) {
  report = r;
  error = '';
  emit();
}

export function loadTokens(): Promise<void> {
  if (loading) return loading;
  loading = api<TokenReport>('/api/tokens/sync')
    .then(
      (r) => setReport(r),
      (e: Error) => {
        // No project open is not an error worth showing.
        report = null;
        error = /project/i.test(e.message) ? '' : e.message;
        emit();
      },
    )
    .finally(() => (loading = null));
  return loading;
}

/** Runs one token action, keeps the report it returns, and passes errors to the caller. */
export async function tokenAction(path: string, body: unknown) {
  const r = await api<TokenReport>(path, body);
  setReport(r);
  return r;
}

/** Files whose edits can change tokens: stylesheets, Tailwind configs and Designer's Figma files. */
export const touchesTokens = (path: string) => /\.(css|scss|pcss)$|tailwind\.config\.|\.designer\/(figma-variables|token-links)\.json$/.test(path);

let timer: ReturnType<typeof setTimeout> | undefined;
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(() => void loadTokens(), 300);
};

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  socket.on((m) => {
    if (m.type === 'project') {
      if (m.project) later();
      else setReport(null);
    } else if (m.type === 'file-change' && touchesTokens(m.change.path) && m.change.tool !== 'Token') later();
    else if (m.type === 'item' && m.item.kind === 'result') later();
  });
}

export function useTokenReport() {
  const [, setTick] = useState(0);
  useEffect(() => {
    wire();
    const l = () => setTick((x) => x + 1);
    listeners.add(l);
    if (!report && !loading) void loadTokens();
    return () => void listeners.delete(l);
  }, []);
  return { report, error };
}
