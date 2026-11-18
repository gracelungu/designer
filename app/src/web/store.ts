import type { ChatItem, FileChange, PermissionMode, ServerMessage } from '../shared/protocol';

export interface SessionState {
  sessionId?: string;
  model?: string;
  effort?: string;
  mode?: PermissionMode;
  running: boolean;
  busy: boolean;
}

export interface ChatState {
  items: ChatItem[];
  changes: FileChange[];
  session: SessionState;
  lastError?: string;
  rewound?: { userMessageId: string; dryRun: boolean; text: string };
}

export const initialChat: ChatState = { items: [], changes: [], session: { running: false, busy: false } };

/** Merge a new item into the list: same id updates in place, keeping fields the update leaves empty. */
export function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const prev = items[i] as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(item)) if (v !== undefined && v !== '') merged[k] = v;
  if (item.kind === 'assistant' && !item.streaming) delete merged.streaming;
  const next = items.slice();
  next[i] = merged as ChatItem;
  return next;
}

export type ChatAction = ServerMessage | { type: 'reset' } | { type: 'clear-rewound' };

export function chatReducer(state: ChatState, m: ChatAction): ChatState {
  switch (m.type) {
    case 'reset':
      return { ...initialChat, session: state.session };
    case 'clear-rewound':
      return { ...state, rewound: undefined };
    case 'session':
      return { ...state, session: { sessionId: m.sessionId, model: m.model, effort: m.effort, mode: m.mode, running: m.running, busy: m.busy } };
    case 'history':
      return { ...state, items: m.items, changes: [] };
    case 'item':
      return { ...state, items: upsert(state.items, m.item) };
    case 'delta':
      return {
        ...state,
        items: state.items.map((x) => (x.id === m.id && (x.kind === 'assistant' || x.kind === 'thinking') ? { ...x, text: x.text + m.text } : x)),
      };
    case 'file-change':
      return { ...state, changes: [...state.changes, m.change] };
    case 'rewound': {
      const r = m.result;
      const text = !r.canRewind
        ? `Can't rewind: ${r.error ?? 'no checkpoint for that message'}`
        : `${m.dryRun ? 'Rewinding would change' : 'Rewound'} ${r.filesChanged?.length ?? 0} file(s) (+${r.insertions ?? 0} −${r.deletions ?? 0})`;
      return { ...state, rewound: { userMessageId: m.userMessageId, dryRun: m.dryRun, text } };
    }
    case 'error':
      return { ...state, lastError: m.text };
  }
}
