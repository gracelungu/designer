import { useEffect, useRef, useState } from 'react';

export function QuickActions({ actions, onClose }: { actions: [string, () => void][]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = actions.filter(([label]) => label.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { dialog.current?.showModal(); }, []);
  const run = (action: () => void) => {
    dialog.current?.close();
    onClose();
    action();
  };

  return (
    <dialog className="quick-actions" aria-label="Quick actions" ref={dialog} data-canvas-keys="off" onCancel={onClose}>
      <input type="search" aria-label="Search actions" placeholder="Search actions" value={query} autoFocus
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            dialog.current?.close();
            onClose();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((n) => Math.max(0, Math.min(matches.length - 1, n + (event.key === 'ArrowDown' ? 1 : -1))));
          } else if (event.key === 'Enter' && matches[active]) run(matches[active][1]);
        }} />
      {matches.length === 0 && <p>No matching actions</p>}
      {matches.map(([label, action], index) => (
        <button key={label} className={index === active ? 'on' : ''} onClick={() => run(action)}>{label}</button>
      ))}
    </dialog>
  );
}
