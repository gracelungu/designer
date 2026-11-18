import { useEffect, useReducer, useState } from 'react';
import type { Editor } from '../../../../editor/src/index.js';

export function FilePanel({ editor }: { editor: Editor }) {
  const { store } = editor;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [menu, setMenu] = useState<string>();
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState(false);
  useEffect(() => store.on((changes) => {
    if (changes.has('doc') || changes.has('selection')) redraw();
  }), [store]);

  const term = query.trim().toLowerCase();
  const matches = term ? Object.values(store.doc.nodes)
    .filter((node) => node.name.toLowerCase().includes(term) ||
      (node.type === 'text' && String(node.text?.content ?? '').toLowerCase().includes(term)))
    .slice(0, 100) : [];

  const reveal = (id: string) => {
    const page = store.pageForNode(id);
    if (page) store.switchPage(page);
    store.select([id]);
    editor.zoomToSelection();
    editor.root.focus();
  };
  const textMatches = replacing && term ? Object.values(store.doc.nodes).filter((node) =>
    node.type === 'text' && String(node.text?.content ?? '').toLowerCase().includes(term)) : [];
  const replaceAll = () => {
    const literal = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (!textMatches.length || !window.confirm(`Replace matching text in ${textMatches.length} layers? You can undo this.`)) return;
    store.transact(() => textMatches.forEach((node) => {
      node.text.content = String(node.text.content).replace(literal, () => replacement);
    }));
  };

  const pages = store.pages();
  return (
    <div className="file-panel" data-canvas-keys="off">
      <div className="file-panel-title">
        <strong>Pages</strong>
        <button className="icon-btn" aria-label="Add page" title="Add page" onClick={() => { store.switchPage(store.addPage()); editor.root.focus(); }}>+</button>
      </div>
      {pages.map((page, index) => {
        const id = page.id ?? 'page-1';
        return (
          <div key={id}>
            <div className="file-page">
              {renaming === id ? (
                <form className="file-rename" onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
                  if (name && name !== page.name) store.transact(() => { page.name = name; });
                  setRenaming(undefined);
                }}>
                  <input name="name" aria-label="Page name" defaultValue={page.name} autoFocus onBlur={() => setRenaming(undefined)} onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(undefined);
                  }} />
                </form>
              ) : (
                <button className={id === store.pageId() ? 'on' : ''} aria-current={id === store.pageId() ? 'page' : undefined} onClick={() => { store.switchPage(id); editor.root.focus(); }} onDoubleClick={() => setRenaming(id)}>{page.name}</button>
              )}
              <button className="icon-btn" aria-expanded={menu === id} aria-label={`Actions for ${page.name}`} onClick={() => setMenu(menu === id ? undefined : id)}>⋯</button>
            </div>
            {menu === id && (
              <div className="file-page-menu" aria-label={`Actions for ${page.name}`}>
                <button onClick={() => { setRenaming(id); setMenu(undefined); }}>Rename</button>
                <button onClick={() => {
                  const duplicate = store.duplicatePage(id);
                  if (duplicate) store.switchPage(duplicate);
                  setMenu(undefined);
                }}>Duplicate</button>
                <button disabled={index === 0} onClick={() => store.reorderPage(id, -1)}>Move up</button>
                <button disabled={index === pages.length - 1} onClick={() => store.reorderPage(id, 1)}>Move down</button>
                {id !== store.pageId() && !!store.selection.length && (
                  <button onClick={() => { store.moveSelectionToPage(id); setMenu(undefined); }}>Move selection here</button>
                )}
                <button disabled={pages.length === 1} onClick={() => {
                  if (window.confirm(`Delete ${page.name} and its layers? You can undo this.`)) {
                    store.removePage(id);
                    setMenu(undefined);
                  }
                }}>Delete page</button>
              </div>
            )}
          </div>
        );
      })}
      <input id="designer-find-layers" type="search" className="input" placeholder="Find layers or text" aria-label="Find layers or text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setQuery('');
          editor.root.focus();
        } else if (e.key === 'Enter' && matches.length) reveal(matches[0].id);
      }} />
      <button className="file-replace-toggle" aria-expanded={replacing} onClick={() => setReplacing(!replacing)}>Replace text</button>
      {replacing && (
        <form className="file-replace" onSubmit={(e) => { e.preventDefault(); replaceAll(); }}>
          <input className="input" aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          <button type="submit" className="btn small" disabled={!textMatches.length}>Replace all ({textMatches.length})</button>
        </form>
      )}
      {term && (
        <div className="file-results" aria-label="Search results">
          {matches.length === 0 && <div className="empty">No matching layers</div>}
          {matches.map((node) => {
            const id = store.pageForNode(node.id);
            return <button className="file-hit" key={node.id} onClick={() => reveal(node.id)}>
              <span>{node.name}</span>
              <small>{store.pages().find((page) => (page.id ?? 'page-1') === id)?.name}</small>
            </button>;
          })}
        </div>
      )}
    </div>
  );
}
