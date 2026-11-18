import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, CommandOption } from '../../shared/protocol';
import { socket } from '../api';
import type { ChatState } from '../store';

export function Chat({ chat, commands, context, clearContext }: { chat: ChatState; commands: CommandOption[]; context?: string; clearContext: () => void }) {
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.items]);

  const slash = text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(
    () => (slash === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slash)).slice(0, 30)),
    [slash, commands],
  );

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    socket.send({ type: 'prompt', text: context && !t.startsWith('/') ? `${context}\n\n${t}` : t });
    setText('');
    clearContext();
  };

  return (
    <div className="chat">
      <div className="messages">
        {chat.items.length === 0 && (
          <div className="empty">
            Ask Claude to change something in this project. It runs your own Claude Code in this folder, with your settings, CLAUDE.md, skills and MCP servers. Type <b>/</b> for your commands and skills.
          </div>
        )}
        {chat.items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {chat.rewound && <div className="result">{chat.rewound.text}</div>}
        {chat.lastError && <div className="error-box">{chat.lastError}</div>}
        <div ref={end} />
      </div>
      <div className="composer">
        {matches.length > 0 && (
          <div className="slash-menu" role="listbox">
            {matches.map((c, i) => (
              <button key={c.name + i} className={i === sel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), setText(`/${c.name} `))}>
                <b>/{c.name}</b> {c.argumentHint && <span className="faint">{c.argumentHint}</span>}
                <div className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.description}</div>
              </button>
            ))}
          </div>
        )}
        {context && (
          <div className="context-chip">
            {context.split('\n')[0].slice(0, 60)}
            <button className="btn ghost small" onClick={clearContext} aria-label="Remove context">×</button>
          </div>
        )}
        <textarea
          value={text}
          placeholder="Ask Claude, or type / for commands"
          onChange={(e) => (setText(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
            } else if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault();
              setText(`/${matches[sel].name} `);
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="bar">
          <span className="muted" style={{ flex: 1 }}>
            {chat.session.busy ? 'Claude is working…' : chat.session.running ? 'Connected to Claude Code' : 'Claude Code starts with your first message'}
          </span>
          {chat.session.busy && (
            <button className="btn small" onClick={() => socket.send({ type: 'interrupt' })}>
              Stop
            </button>
          )}
          <button className="btn primary small" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {item.text}
          {item.userMessageId && (
            <button
              className="rewind"
              title="Put the files back the way they were before this message"
              onClick={() => {
                if (confirm('Rewind the files Claude changed after this message?')) socket.send({ type: 'rewind', userMessageId: item.userMessageId! });
              }}
            >
              Rewind to here
            </button>
          )}
        </div>
      );
    case 'assistant':
      return <div className="msg-assistant">{item.text || (item.streaming ? '…' : '')}</div>;
    case 'thinking':
      return item.text ? <div className="msg-thinking">{item.text}</div> : null;
    case 'tool':
      return (
        <div className="step" onClick={() => setOpen(!open)} role="button">
          <span className={`dot ${item.status}`} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>{item.summary || item.name}</div>
            {open && item.output && <pre>{item.output}</pre>}
          </div>
        </div>
      );
    case 'permission':
      return (
        <div className="perm">
          <b>{item.summary}</b>
          {item.tool === 'ExitPlanMode' ? <pre>{String((item.input as { plan?: string })?.plan ?? '')}</pre> : <PermissionDetail tool={item.tool} input={item.input} />}
          {item.state === 'pending' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn primary small" onClick={() => socket.send({ type: 'permission', requestId: item.requestId, allow: true })}>
                {item.tool === 'ExitPlanMode' ? 'Approve plan' : 'Allow'}
              </button>
              <button className="btn small" onClick={() => socket.send({ type: 'permission', requestId: item.requestId, allow: false })}>
                {item.tool === 'ExitPlanMode' ? 'Keep planning' : 'Deny'}
              </button>
            </div>
          ) : (
            <span className="muted">{item.state === 'allowed' ? 'Allowed' : 'Denied'}</span>
          )}
        </div>
      );
    case 'result':
      return (
        <div className="result">
          {item.ok ? 'Done' : `Stopped: ${item.text}`}
          {item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}
          {item.costUsd ? ` · $${item.costUsd.toFixed(4)}` : ''}
        </div>
      );
    case 'system':
      return <div className="result">{item.text}</div>;
    case 'error':
      return <div className="error-box">{item.text}</div>;
  }
}

function PermissionDetail({ tool, input }: { tool: string; input: unknown }) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === 'Bash') return <pre>{String(i.command ?? '')}</pre>;
  if (tool === 'Edit' || tool === 'MultiEdit')
    return (
      <pre>
        {i.old_string !== undefined ? `− ${String(i.old_string)}\n+ ${String(i.new_string)}` : JSON.stringify(i.edits ?? i, null, 2)}
      </pre>
    );
  if (tool === 'Write') return <pre>{String(i.content ?? '').slice(0, 1500)}</pre>;
  return <pre>{JSON.stringify(input, null, 2).slice(0, 1500)}</pre>;
}
