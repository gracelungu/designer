import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Attachment, Capabilities, ChatItem, CommandOption } from '../../shared/protocol';
import { socket } from '../api';
import type { ChatState } from '../store';
import { Markdown } from './Markdown';

export interface Prefs {
  model?: string;
  effort?: string;
  mode?: string;
}

export interface CanvasContext {
  /** Shown on the chip, e.g. "Card · Frame". */
  label: string;
  /** What Claude is told. */
  text: string;
}

type Tool = Extract<ChatItem, { kind: 'tool' }>;
type Thinking = Extract<ChatItem, { kind: 'thinking' }>;
type Row = { kind: 'item'; item: ChatItem } | { kind: 'steps'; id: string; steps: (Tool | Thinking)[] };

/** Groups each run of tool calls and thinking into one collapsible "steps" row, the way Claude's apps do. */
export function groupRows(items: ChatItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'thinking') {
      if (item.kind === 'thinking' && !item.text) continue;
      const last = rows[rows.length - 1];
      if (last && last.kind === 'steps') last.steps.push(item);
      else rows.push({ kind: 'steps', id: item.id, steps: [item] });
    } else rows.push({ kind: 'item', item });
  }
  return rows;
}

const SPARK = 'M8 1.5L9.4 6.6L14.5 8L9.4 9.4L8 14.5L6.6 9.4L1.5 8L6.6 6.6Z';
export const Spark = ({ spin, size = 16 }: { spin?: boolean; size?: number }) => (
  <svg className={`spark ${spin ? 'spin' : ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d={SPARK} fill="currentColor" />
  </svg>
);

export function Chat({
  chat,
  caps,
  prefs,
  onChoose,
  context,
  hasProject,
  suggestions,
  header,
}: {
  chat: ChatState;
  caps?: Capabilities;
  prefs: Prefs;
  onChoose: (p: Prefs) => void;
  context?: CanvasContext;
  hasProject: boolean;
  suggestions: { label: string; prompt: string }[];
  header: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const rows = useMemo(() => groupRows(chat.items), [chat.items]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows, chat.lastError]);

  const send = (text: string, attachments: Attachment[], ctx?: CanvasContext) => {
    pinned.current = true;
    socket.send({ type: 'prompt', text, attachments, context: ctx?.text });
  };

  const empty = chat.items.length === 0;
  const lastRow = rows[rows.length - 1];
  const working = chat.session.busy;

  return (
    <div className="chat" data-canvas-keys="off">
      {header}
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {empty ? (
          <div className="chat-empty">
            <div className="hello">
              <Spark size={22} />
              <h2>{hasProject ? 'What should we design?' : 'What are we working on?'}</h2>
            </div>
            <p>{hasProject ? 'Ask for a change, select something on the canvas and ask about it, or type / for your commands and skills.' : 'Mention a project and Claude will open it and work out how to run it. Or start something new from scratch.'}</p>
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s.label} onClick={() => send(s.prompt, [])}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {rows.map((r) => (r.kind === 'steps' ? <Steps key={r.id} steps={r.steps} live={working && r === lastRow} /> : <Item key={r.item.id} item={r.item} />))}
            {chat.rewound && <div className="note">{chat.rewound.text}</div>}
            {chat.lastError && <div className="error-box">{chat.lastError}</div>}
            {working && !(lastRow?.kind === 'item' && lastRow.item.kind === 'assistant' && lastRow.item.streaming) && (
              <div className="working">
                <Spark spin />
              </div>
            )}
          </div>
        )}
      </div>
      <Composer chat={chat} caps={caps} prefs={prefs} onChoose={onChoose} context={context} onSend={send} />
    </div>
  );
}

// ---------- messages ----------

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {item.attachments && item.attachments.length > 0 && (
            <div className="msg-attachments">
              {item.attachments.map((a, i) => (a.preview ? <img key={i} src={a.preview} alt={a.name} /> : <span key={i} className="file-chip">{a.name}</span>))}
            </div>
          )}
          {item.context && <div className="msg-context">{contextLabel(item.context)}</div>}
          <div className="bubble">{item.text}</div>
          <div className="msg-actions">
            <CopyButton text={item.text} />
            {item.userMessageId && (
              <button
                className="act"
                title="Put the files back the way they were before this message"
                onClick={() => {
                  if (confirm('Undo the file changes Claude made from this message on?')) socket.send({ type: 'rewind', userMessageId: item.userMessageId! });
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3L2.5 6L5.5 9M2.5 6H10A3.5 3.5 0 0 1 10 13H7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Restore files
              </button>
            )}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg-assistant">
          <Markdown text={item.text} />
          {item.streaming && <span className="caret" />}
          {!item.streaming && item.text && (
            <div className="msg-actions">
              <CopyButton text={item.text} />
            </div>
          )}
        </div>
      );
    case 'permission':
      return <Permission item={item} />;
    case 'result':
      return item.ok ? null : <div className="note warn">Stopped: {item.text}</div>;
    case 'system':
      return <div className="note">{item.text}</div>;
    case 'error':
      return <div className="error-box">{item.text}</div>;
    default:
      return null;
  }
}

function contextLabel(context: string) {
  const m = /selected on the canvas: (.*?)(\.|$)/.exec(context);
  return m ? `Canvas: ${m[1].slice(0, 80)}` : 'Canvas context';
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="act"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4A1.3 1.3 0 0 0 3.8 10.5H5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      )}
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function stepKind(t: Tool): 'read' | 'edit' | 'run' | 'search' | 'web' | 'canvas' | 'figma' | 'plan' | 'agent' | 'other' {
  const n = t.name;
  if (n === 'Read' || n === 'NotebookRead') return 'read';
  if (n === 'Edit' || n === 'Write' || n === 'MultiEdit' || n === 'NotebookEdit') return 'edit';
  if (n === 'Bash' || n === 'BashOutput') return 'run';
  if (n === 'Grep' || n === 'Glob' || n === 'LS') return 'search';
  if (n === 'WebFetch' || n === 'WebSearch') return 'web';
  if (n.startsWith('mcp__designer__')) return 'canvas';
  if (n.startsWith('mcp__figma')) return 'figma';
  if (n === 'TodoWrite' || n === 'ExitPlanMode') return 'plan';
  if (n === 'Task' || n === 'Agent') return 'agent';
  return 'other';
}

const STEP_ICON: Record<string, string> = {
  read: 'M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13',
  edit: 'M10.8 2.2l3 3-8.3 8.3-3.6.7.7-3.6zM9.3 3.7l3 3',
  run: 'M2 3h12v10H2zM4.5 6.5L6.5 8l-2 1.5M8 10h3',
  search: 'M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM10.3 10.3L13.5 13.5',
  web: 'M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13',
  canvas: 'M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13',
  figma: 'M5 1.5h6v4.5H5zM5 6h6v4.5H5zM5 10.5h3v4H5z',
  plan: 'M3 4h10M3 8h10M3 12h6',
  agent: 'M8 2.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5zM3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4',
  other: 'M8 1.5L9.4 6.6L14.5 8L9.4 9.4L8 14.5L6.6 9.4L1.5 8L6.6 6.6Z',
  thinking: 'M8 2a4 4 0 0 1 2.5 7.1V11h-5V9.1A4 4 0 0 1 8 2zM6 13.5h4',
};

/** "Read 3 files, edited 2 files, ran a command" for a collapsed run of steps. */
export function stepsSummary(steps: (Tool | Thinking)[]) {
  const c: Record<string, number> = {};
  for (const s of steps) {
    const k = s.kind === 'thinking' ? 'thinking' : stepKind(s);
    c[k] = (c[k] ?? 0) + 1;
  }
  const n = (k: string, one: string, many: string) => (c[k] ? (c[k] === 1 ? one : many.replace('#', String(c[k]))) : '');
  const parts = [
    n('thinking', 'Thought', 'Thought'),
    n('read', 'read a file', 'read # files'),
    n('search', 'searched the code', 'searched # times'),
    n('edit', 'edited a file', 'made # edits'),
    n('run', 'ran a command', 'ran # commands'),
    n('canvas', 'worked on the canvas', 'worked on the canvas'),
    n('figma', 'read Figma', 'read Figma'),
    n('web', 'looked something up', 'looked # things up'),
    n('plan', 'updated the plan', 'updated the plan'),
    n('agent', 'started a helper', 'started # helpers'),
    n('other', 'used a tool', 'used # tools'),
  ].filter(Boolean);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Steps({ steps, live }: { steps: (Tool | Thinking)[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = steps.find((s) => s.kind === 'tool' && s.status === 'running') as Tool | undefined;
  const failed = steps.some((s) => s.kind === 'tool' && s.status === 'error');
  const current = live ? (running ?? steps[steps.length - 1]) : undefined;
  const label = current ? (current.kind === 'thinking' ? 'Thinking' : current.summary || current.name) : stepsSummary(steps);
  return (
    <div className={`steps ${open ? 'open' : ''}`}>
      <button className="steps-head" onClick={() => setOpen(!open)}>
        <span className={`steps-label ${current ? 'shimmer' : ''}`}>{label}</span>
        {failed && !current && <span className="steps-err">had an error</span>}
        <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="steps-body">
          {steps.map((s) => (
            <Step key={s.id} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function Step({ step }: { step: Tool | Thinking }) {
  const [open, setOpen] = useState(false);
  if (step.kind === 'thinking')
    return (
      <div className="step">
        <svg className="step-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={STEP_ICON.thinking} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="step-main">
          <button className="step-title" onClick={() => setOpen(!open)}>Thinking</button>
          {open && <div className="thinking-text">{step.text}</div>}
        </div>
      </div>
    );
  const kind = stepKind(step);
  const detail = toolDetail(step);
  return (
    <div className={`step ${step.status}`}>
      <svg className="step-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={STEP_ICON[kind]} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <div className="step-main">
        <button className="step-title" onClick={() => setOpen(!open)} disabled={!detail && !step.output}>
          <span className={step.status === 'running' ? 'shimmer' : ''}>{step.summary || step.name}</span>
          {step.status === 'error' && <span className="steps-err">error</span>}
        </button>
        {open && (
          <>
            {detail && <pre className="step-detail">{detail}</pre>}
            {step.output && <pre className="step-output">{step.output}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function toolDetail(t: Tool) {
  const i = (t.input ?? {}) as Record<string, unknown>;
  if (t.name === 'Bash') return String(i.command ?? '');
  if (t.name === 'Edit') return i.old_string !== undefined ? `− ${String(i.old_string)}\n+ ${String(i.new_string)}` : '';
  if (t.name === 'Write') return String(i.content ?? '').slice(0, 2000);
  if (t.name === 'TodoWrite') return ((i.todos as { content: string; status: string }[]) ?? []).map((x) => `${x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '›' : '○'} ${x.content}`).join('\n');
  if (t.name.startsWith('mcp__')) return Object.keys(i).length ? JSON.stringify(i, null, 1).slice(0, 2000) : '';
  return '';
}

function Permission({ item }: { item: Extract<ChatItem, { kind: 'permission' }> }) {
  const plan = item.tool === 'ExitPlanMode';
  const i = (item.input ?? {}) as Record<string, unknown>;
  const answer = (allow: boolean) => socket.send({ type: 'permission', requestId: item.requestId, allow });
  return (
    <div className={`perm ${item.state}`}>
      <div className="perm-title">{plan ? 'Claude has a plan' : `Allow Claude to ${lower(item.summary)}?`}</div>
      {plan ? (
        <div className="perm-plan">
          <Markdown text={String(i.plan ?? '')} />
        </div>
      ) : (
        <PermissionDetail tool={item.tool} input={item.input} />
      )}
      {item.state === 'pending' ? (
        <div className="perm-actions">
          <button className="btn primary" onClick={() => answer(true)}>{plan ? 'Approve plan' : 'Allow'}</button>
          <button className="btn" onClick={() => answer(false)}>{plan ? 'Keep planning' : 'Deny'}</button>
        </div>
      ) : (
        <div className="perm-state">{item.state === 'allowed' ? (plan ? 'Approved' : 'Allowed') : plan ? 'Kept planning' : 'Denied'}</div>
      )}
    </div>
  );
}

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : 'use a tool');

function PermissionDetail({ tool, input }: { tool: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === 'Bash') return <pre>{String(i.command ?? '')}</pre>;
  if (tool === 'Edit' || tool === 'MultiEdit')
    return <pre>{i.old_string !== undefined ? `− ${String(i.old_string)}\n+ ${String(i.new_string)}` : JSON.stringify(i.edits ?? i, null, 2)}</pre>;
  if (tool === 'Write') return <pre>{String(i.content ?? '').slice(0, 1500)}</pre>;
  if (input === undefined) return null;
  return <pre>{JSON.stringify(input, null, 2).slice(0, 1500)}</pre>;
}

// ---------- composer ----------

const TEXT_FILE = /\.(txt|md|mdx|json|jsx?|tsx?|css|scss|html?|svg|ya?ml|toml|csv|py|rb|go|rs|swift|kt|java|vue|svelte)$/i;

async function readAttachment(file: File): Promise<Attachment | null> {
  if (file.type.startsWith('image/') && /png|jpe?g|gif|webp/.test(file.type)) {
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    return { name: file.name || 'image.png', mediaType: file.type, data };
  }
  if ((file.type.startsWith('text/') || TEXT_FILE.test(file.name)) && file.size < 400_000) return { name: file.name, mediaType: file.type || 'text/plain', data: await file.text() };
  return null;
}

function Composer({
  chat,
  caps,
  prefs,
  onChoose,
  context,
  onSend,
}: {
  chat: ChatState;
  caps?: Capabilities;
  prefs: Prefs;
  onChoose: (p: Prefs) => void;
  context?: CanvasContext;
  onSend: (text: string, attachments: Attachment[], ctx?: CanvasContext) => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sel, setSel] = useState(0);
  const [dropped, setDropped] = useState<string>();
  const [menu, setMenu] = useState<'model' | 'mode' | 'plus' | null>(null);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = chat.session;

  // A dismissed selection chip comes back when the selection changes.
  const ctx = context && context.text !== dropped ? context : undefined;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    const focus = () => ta.current?.focus();
    // Another panel can start a message for the designer to finish ("About this change: …").
    const prefill = (e: Event) => {
      setText(String((e as CustomEvent).detail ?? ''));
      setTimeout(focus, 0);
    };
    window.addEventListener('designer:focus-chat', focus);
    window.addEventListener('designer:prefill', prefill);
    return () => {
      window.removeEventListener('designer:focus-chat', focus);
      window.removeEventListener('designer:prefill', prefill);
    };
  }, []);

  const slash = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches: CommandOption[] = useMemo(() => {
    if (slash === null || !caps) return [];
    const all = caps.commands;
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(slash));
    const rest = all.filter((c) => !c.name.toLowerCase().startsWith(slash) && c.name.toLowerCase().includes(slash));
    return [...starts, ...rest].slice(0, 40);
  }, [slash, caps]);

  const model = caps?.models.find((m) => m.value === (s.model ?? prefs.model)) ?? caps?.models.find((m) => m.value === 'default') ?? caps?.models[0];
  const modes = caps?.modes.filter((m) => m.value !== 'auto' || model?.supportsAutoMode) ?? [];
  const mode = modes.find((m) => m.value === (s.mode ?? prefs.mode)) ?? modes[0];
  const effort = s.effort ?? prefs.effort;

  const addFiles = async (list: FileList | File[]) => {
    const read = (await Promise.all([...list].map(readAttachment))).filter(Boolean) as Attachment[];
    setFiles((f) => [...f, ...read].slice(0, 10));
  };

  const submit = () => {
    const t = text.trim();
    if ((!t && !files.length) || s.busy) return;
    onSend(t || 'See the attached files.', files, t.startsWith('/') ? undefined : ctx);
    setText('');
    setFiles([]);
  };

  return (
    <div
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {matches.length > 0 && (
        <div className="slash-menu" role="listbox">
          {matches.map((c, i) => (
            <button key={c.name + i} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), setText(`/${c.name} `))}>
              <span className="slash-name">/{c.name}</span>
              {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        {(files.length > 0 || ctx) && (
          <div className="composer-chips">
            {ctx && (
              <span className="ctx-chip" title={ctx.text}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5l9 5-4.2 1.1-1.8 4.2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                {ctx.label}
                <button aria-label="Don't include the selection" onClick={() => setDropped(ctx.text)}>×</button>
              </span>
            )}
            {files.map((f, i) => (
              <span key={i} className={`att ${f.mediaType.startsWith('image/') ? 'img' : ''}`}>
                {f.mediaType.startsWith('image/') ? <img src={`data:${f.mediaType};base64,${f.data}`} alt={f.name} /> : <span className="att-name">{f.name}</span>}
                <button aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={chat.items.length ? 'Reply to Claude…' : 'Ask Claude to design, build or change something…'}
          onChange={(e) => (setText(e.target.value), setSel(0))}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files];
            if (imgs.length) {
              e.preventDefault();
              void addFiles(imgs);
            }
          }}
          onKeyDown={(e) => {
            if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setSel((v) => (v + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
            } else if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault();
              setText(`/${matches[sel].name} `);
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape' && s.busy) {
              socket.send({ type: 'interrupt' });
            }
          }}
        />
        <div className="composer-bar">
          <div className="pop-anchor">
            <button className="round-btn" aria-label="Add files and more" title="Add files and more" onClick={() => setMenu(menu === 'plus' ? null : 'plus')}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            {menu === 'plus' && (
              <Menu onClose={() => setMenu(null)} up>
                <button className="opt" onClick={() => (fileInput.current?.click(), setMenu(null))}>
                  <span>Add images or files</span>
                </button>
                <button className="opt" onClick={() => (setText('/'), setMenu(null), ta.current?.focus())}>
                  <span>Commands and skills</span>
                </button>
                <button className="opt" onClick={() => (window.dispatchEvent(new CustomEvent('designer:figma')), setMenu(null))}>
                  <span>Import from Figma</span>
                </button>
              </Menu>
            )}
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && void addFiles(e.target.files), (e.target.value = ''))} />
          {mode && (
            <div className="pop-anchor">
              <button className={`pill ${mode.value === 'plan' ? 'plan' : ''}`} onClick={() => setMenu(menu === 'mode' ? null : 'mode')} title={mode.description}>
                <span className="pill-text">{mode.label}</span>
                <Chevron />
              </button>
              {menu === 'mode' && (
                <Menu onClose={() => setMenu(null)} up>
                  {modes.map((m) => (
                    <button key={m.value} className="opt" onClick={() => (onChoose({ mode: m.value }), setMenu(null))}>
                      <span className="check">{m.value === mode.value ? '✓' : ''}</span>
                      <span>
                        {m.label}
                        <small>{m.description}</small>
                      </span>
                    </button>
                  ))}
                </Menu>
              )}
            </div>
          )}
          <span className="grow" />
          <div className="pop-anchor">
            <button className="pill ghost" onClick={() => setMenu(menu === 'model' ? null : 'model')} disabled={!caps}>
              <span className="pill-text">
                {model?.displayName ?? 'Claude'}
                {effort && <span className="faint"> · {effort}</span>}
              </span>
              <Chevron />
            </button>
            {menu === 'model' && caps && (
              <Menu onClose={() => setMenu(null)} up right>
                {caps.models.map((m) => (
                  <button key={m.value} className="opt" onClick={() => (onChoose({ model: m.value }), setMenu(null))}>
                    <span className="check">{m.value === model?.value ? '✓' : ''}</span>
                    <span>
                      {m.displayName}
                      <small>{m.description}</small>
                    </span>
                  </button>
                ))}
                {model && model.supportedEffortLevels.length > 0 && (
                  <>
                    <h4>Effort</h4>
                    <div className="efforts">
                      {model.supportedEffortLevels.map((e) => (
                        <button key={e} className={effort === e ? 'on' : ''} onClick={() => onChoose({ effort: e })}>
                          {e}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </Menu>
            )}
          </div>
          {s.busy ? (
            <button className="send stop" aria-label="Stop" title="Stop (Esc)" onClick={() => socket.send({ type: 'interrupt' })}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="1.5" fill="currentColor" /></svg>
            </button>
          ) : (
            <button className="send" aria-label="Send" title="Send (Enter)" onClick={submit} disabled={!text.trim() && !files.length}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot">{s.running ? `Claude Code${caps?.claudeVersion ? ` ${caps.claudeVersion}` : ''} on this computer` : 'Claude Code starts with your first message'}</div>
    </div>
  );
}

const Chevron = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export function Menu({ children, onClose, up, right }: { children: ReactNode; onClose: () => void; up?: boolean; right?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', away));
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`popover ${up ? 'up' : ''} ${right ? 'right' : ''}`}>
      {children}
    </div>
  );
}
