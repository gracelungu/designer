import { useEffect, useReducer, useState } from 'react';
import { cssFor, type CodeInfo, type Editor, type EditorNode } from '../../../../editor/src/index.js';
import type { StoryEntry } from '../../shared/protocol';
import { parseColor } from '../canvas/convert';

/** Re-renders when the canvas changes, so panels stay in step with the selection and live renders. */
export function useCanvasTick(editor: Editor) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => editor.store.on((ch) => (ch.has('selection') || ch.has('commit') || ch.has('code') || ch.has('doc') ? tick() : undefined)), [editor]);
}

type Arg = NonNullable<CodeInfo['argTypes']>[string];

/** The Code side of a selected layer: a component's real props, or how a design layer maps to code. */
export function CodePanel({
  editor,
  stories,
  onAsk,
  onShowStory,
}: {
  editor: Editor;
  stories: StoryEntry[];
  onAsk: (prompt: string) => void;
  onShowStory: (storyId: string, nextTo: boolean) => void;
}) {
  useCanvasTick(editor);
  const store = editor.store;
  const sel = store.selected();
  if (sel.length !== 1) return <div className="empty">{sel.length ? `${sel.length} layers selected. Select one to see its code.` : ''}</div>;
  const n = sel[0];
  if (n.type === 'code' && n.code?.kind === 'page') return <PageCode n={n} editor={editor} />;
  if (n.type === 'code') return <ComponentCode n={n} editor={editor} onAsk={onAsk} />;
  return <DesignCode n={n} editor={editor} stories={stories} onAsk={onAsk} onShowStory={onShowStory} />;
}

function ComponentCode({ n, editor, onAsk }: { n: EditorNode; editor: Editor; onAsk: (p: string) => void }) {
  const store = editor.store;
  const info: CodeInfo = editor.code.info.get(n.id) ?? {};
  const code = n.code!;
  const args = { ...(info.initialArgs ?? {}), ...(code.args ?? {}) };
  const setArg = (k: string, v: unknown) => {
    store.transact(() => {
      code.args = { ...code.args, [k]: v };
    });
  };
  // "Components/Button" from Storybook, or "Button / Primary" as placed: the component is Button.
  const name = (info.title ? info.title.split('/').pop()! : (code.title || n.name).split(' / ')[0]).replace(/\s+/g, '');
  const changed = Object.entries(code.args ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(info.initialArgs?.[k]));
  const jsx = `<${name}${Object.entries(args)
    .filter(([k]) => k !== 'children')
    .map(([k, v]) => (typeof v === 'string' ? ` ${k}="${v}"` : v === true ? ` ${k}` : typeof v === 'number' || typeof v === 'boolean' ? ` ${k}={${v}}` : ''))
    .join('')}${args.children !== undefined && typeof args.children === 'string' ? `>${args.children}</${name}>` : ' />'}`;
  const groups = Object.entries(info.argTypes ?? {});
  return (
    <div className="scroll code-panel">
      <div className="cp-head">
        <div className="cp-title">
          <span className="code-glyph">{'</>'}</span>
          {name}
        </div>
        {code.file && <div className="faint mono">{code.file}</div>}
        {code.storyId && <div className="faint mono">{code.storyId}</div>}
      </div>
      {info.error && <div className="error-box" style={{ margin: '0 12px 8px' }}>{info.error}</div>}
      {!code.src && <div className="empty">This component isn't rendering yet. Start Storybook from the Components tab, or ask Claude.</div>}
      <div className="section-title">
        Props
        {changed.length > 0 && (
          <button className="btn small ghost" onClick={() => store.transact(() => void (code.args = {}))}>
            Reset
          </button>
        )}
      </div>
      {code.src && !info.argTypes && <div className="empty">Reading props from the component…</div>}
      {info.argTypes && groups.length === 0 && <div className="empty">This story has no editable props.</div>}
      {groups.map(([k, a]) => (
        <PropRow key={k} name={k} arg={a} value={args[k]} changed={code.args?.[k] !== undefined} onChange={(v) => setArg(k, v)} />
      ))}
      <div className="section-title">Size</div>
      <div className="row">
        <div className="segmented small">
          <button className={code.hug ? 'on' : ''} onClick={() => store.transact(() => void (code.hug = true))}>Hug contents</button>
          <button className={!code.hug ? 'on' : ''} onClick={() => store.transact(() => void (code.hug = false))}>Fixed</button>
        </div>
        <span className="faint">{Math.round(n.w)} × {Math.round(n.h)}</span>
      </div>
      <div className="section-title">Usage</div>
      <pre className="snippet">{jsx}</pre>
      <div className="cp-actions">
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(jsx)}>Copy code</button>
        <button className="btn" onClick={() => editor.code.interact(n.id)}>Try it live</button>
        <button
          className="btn primary"
          onClick={() => onAsk(`Change the ${name} component${code.file ? ` (${code.file})` : ''}: `)}
        >
          Change with Claude
        </button>
      </div>
    </div>
  );
}

function PropRow({ name, arg, value, changed, onChange }: { name: string; arg: Arg; value: unknown; changed: boolean; onChange: (v: unknown) => void }) {
  const control = arg.control ?? (arg.type === 'boolean' ? 'boolean' : arg.type === 'number' ? 'number' : arg.options ? 'select' : 'text');
  let input;
  if (control === 'boolean')
    input = (
      <label className="switch">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </label>
    );
  else if ((control === 'select' || control === 'radio' || control === 'inline-radio' || control === 'inline-check') && arg.options)
    input = (
      <select className="input" value={String(value ?? '')} onChange={(e) => onChange(arg.options!.find((o) => String(o) === e.target.value) ?? e.target.value)}>
        {value === undefined && <option value="">—</option>}
        {arg.options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  else if (control === 'number' || control === 'range')
    input = <input className="input" type="number" value={value === undefined ? '' : Number(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  else if (control === 'color') {
    const c = parseColor(String(value ?? ''));
    input = (
      <span className="color-input">
        <input type="color" value={c?.color.toLowerCase() ?? '#000000'} onChange={(e) => onChange(e.target.value)} />
        <input className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </span>
    );
  } else if (control === 'object' || (typeof value === 'object' && value !== null))
    input = <span className="faint mono">{JSON.stringify(value)?.slice(0, 40) ?? '—'}</span>;
  else input = <TextProp value={value === undefined ? '' : String(value)} onChange={onChange} />;
  return (
    <div className="prop-row" title={arg.description || undefined}>
      <span className={`prop-name ${changed ? 'changed' : ''}`}>{name}</span>
      {input}
    </div>
  );
}

function TextProp({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="input" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

function PageCode({ n, editor }: { n: EditorNode; editor: Editor }) {
  const code = n.code!;
  return (
    <div className="scroll code-panel">
      <div className="cp-head">
        <div className="cp-title">
          <span className="code-glyph">{'</>'}</span>
          {n.name}
        </div>
        <div className="faint mono">{code.url}</div>
      </div>
      <div className="empty">This is your running app, live from the dev server. It updates when the code changes.</div>
      <div className="cp-actions">
        <button className="btn" onClick={() => editor.code.interact(n.id)}>Use it</button>
        <button
          className="btn"
          onClick={() => {
            const f = editor.code.frames.get(n.id);
            if (f) f.iframe.src = code.src;
          }}
        >
          Reload
        </button>
        {code.url && (
          <a className="btn" href={code.url} target="_blank" rel="noreferrer" onClick={(e) => window.designerNative && (e.preventDefault(), window.designerNative.openExternal(code.url!))}>
            Open in browser
          </a>
        )}
      </div>
    </div>
  );
}

function DesignCode({ n, editor, stories, onAsk, onShowStory }: { n: EditorNode; editor: Editor; stories: StoryEntry[]; onAsk: (p: string) => void; onShowStory: (id: string, nextTo: boolean) => void }) {
  const [linking, setLinking] = useState(false);
  const store = editor.store;
  const link = n.codeLink;
  const entry = link?.storyId ? stories.find((e) => e.stories.some((s) => s.id === link.storyId)) : undefined;
  const css = cssFor(store, n);
  return (
    <div className="scroll code-panel">
      {link?.storyId ? (
        <>
          <div className="cp-head">
            <div className="faint">In code as</div>
            <div className="cp-title">
              <span className="code-glyph">{'</>'}</span>
              {entry?.title.split('/').pop() ?? link.storyId}
            </div>
            <div className="faint mono">{entry?.file ?? link.file}</div>
          </div>
          <div className="cp-actions">
            <button className="btn primary" onClick={() => onShowStory(link.storyId!, true)}>Show code version beside it</button>
            <button className="btn" onClick={() => onAsk(`Make the coded component (story ${link.storyId}) match the "${n.name}" design on the canvas exactly. Read the design with get_canvas, change the component using our tokens, then show_component next to the design and compare.`)}>
              Match code to design
            </button>
            <button className="btn ghost" onClick={() => store.transact(() => void delete n.codeLink)}>Unlink</button>
          </div>
        </>
      ) : (
        <>
          <div className="cp-head">
            <div className="cp-title">Not in code yet</div>
            <div className="faint">Build this as a component in your repo, or link it to one that already exists.</div>
          </div>
          <div className="cp-actions">
            <button
              className="btn primary"
              onClick={() =>
                onAsk(
                  `Build the selected "${n.name}" design as a component in this repo. Read it with get_canvas, follow the repo's component conventions and tokens, add a Storybook story for each variant, then show_component next to the design so we can compare, and link them.`,
                )
              }
            >
              Build in code with Claude
            </button>
            <button className="btn" onClick={() => setLinking(!linking)} disabled={!stories.length}>Link to a component</button>
          </div>
          {linking && (
            <div className="link-list">
              {stories.flatMap((e) =>
                e.stories.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      store.transact(() => void (n.codeLink = { storyId: s.id, file: e.file, exportName: s.exportName }));
                      setLinking(false);
                    }}
                  >
                    <b>{e.title.split('/').pop()}</b> <span className="faint">{s.name}</span>
                  </button>
                )),
              )}
            </div>
          )}
        </>
      )}
      <div className="section-title">CSS</div>
      <pre className="snippet">{css}</pre>
      <div className="cp-actions">
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(css)}>Copy CSS</button>
      </div>
    </div>
  );
}

const px = (v: string | undefined) => (v ? Math.round(parseFloat(v) * 10) / 10 : 0);

/** A coded component's rendered styles, shown the way Figma names them (Fill, Stroke, Corner radius, Auto layout, Text). */
export function RenderedStyles({ editor }: { editor: Editor }) {
  useCanvasTick(editor);
  const sel = editor.store.selected();
  const n = sel.length === 1 && sel[0].type === 'code' && sel[0].code?.kind === 'component' ? sel[0] : null;
  if (!n) return null;
  const s = editor.code.info.get(n.id)?.styles;
  if (!s) return <div className="rendered"><div className="section-title">From code</div><div className="empty">Waiting for the component to render…</div></div>;
  const fill = parseColor(s.backgroundColor);
  const text = parseColor(s.color);
  const stroke = px(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' ? parseColor(s.borderTopColor) : null;
  const radii = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(px);
  const flex = /flex/.test(s.display ?? '');
  const pad = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px);
  const Swatch = ({ c }: { c: { color: string; opacity: number } }) => (
    <span className="swatch-row">
      <span className="swatch" style={{ background: c.color, opacity: c.opacity }} />
      <span className="mono">{c.color.replace('#', '')}</span>
      <span className="faint">{Math.round(c.opacity * 100)}%</span>
    </span>
  );
  return (
    <div className="rendered">
      <div className="section-title">
        From code <span className="faint" style={{ fontWeight: 400 }}>&lt;{s.tag}&gt;</span>
      </div>
      {flex && (
        <div className="kv">
          <span>Auto layout</span>
          <span>
            {s.flexDirection?.startsWith('column') ? 'Vertical' : 'Horizontal'} · gap {px(s.gap)} · padding {pad.every((p) => p === pad[0]) ? pad[0] : pad.join(' ')}
          </span>
        </div>
      )}
      {!flex && pad.some(Boolean) && (
        <div className="kv">
          <span>Padding</span>
          <span>{pad.join(' ')}</span>
        </div>
      )}
      <div className="kv">
        <span>Fill</span>
        {fill && fill.opacity > 0 ? <Swatch c={fill} /> : <span className="faint">None</span>}
      </div>
      {stroke && (
        <div className="kv">
          <span>Stroke</span>
          <span>
            <Swatch c={stroke} /> <span className="faint">{px(s.borderTopWidth)}</span>
          </span>
        </div>
      )}
      <div className="kv">
        <span>Corner radius</span>
        <span>{radii.every((r) => r === radii[0]) ? radii[0] : radii.join(' ')}</span>
      </div>
      <div className="kv">
        <span>Text</span>
        <span>
          {(s.fontFamily ?? '').split(',')[0].replace(/["']/g, '')} · {s.fontWeight} · {px(s.fontSize)}
          {s.lineHeight && s.lineHeight !== 'normal' ? `/${px(s.lineHeight)}` : ''}
        </span>
      </div>
      {text && (
        <div className="kv">
          <span>Text colour</span>
          <Swatch c={text} />
        </div>
      )}
      {s.boxShadow && s.boxShadow !== 'none' && (
        <div className="kv">
          <span>Effects</span>
          <span className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.boxShadow}</span>
        </div>
      )}
      <div className="faint" style={{ padding: '4px 12px 12px' }}>These come from the running code. Change them in the Code tab, or ask Claude.</div>
    </div>
  );
}
