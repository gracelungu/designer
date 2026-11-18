import { useEffect, useState } from 'react';
import type { UpdateState } from '../api';

/** A small notice in the top bar when a new version of the Mac app is ready or available. */
export function UpdatePill() {
  const [u, setU] = useState<UpdateState>();
  useEffect(() => {
    const native = window.designerNative;
    if (!native?.onUpdate) return;
    void native.getUpdate?.().then(setU);
    return native.onUpdate(setU);
  }, []);
  if (!u) return null;
  if (u.state === 'ready')
    return (
      <button className="update-pill ready" data-testid="update-pill" title={`Designer ${u.version ?? ''} is downloaded`} onClick={() => window.designerNative?.installUpdate?.()}>
        <span className="dot" /> Restart to update
      </button>
    );
  if (u.state === 'available' && u.url)
    return (
      <button className="update-pill" data-testid="update-pill" title="Opens the download page" onClick={() => window.designerNative?.openExternal(u.url!)}>
        <span className="dot" /> Designer {u.version} is out · Download
      </button>
    );
  if (u.state === 'downloading')
    return (
      <span className="update-pill" data-testid="update-pill">
        <span className="dot" /> Updating{u.percent ? ` ${Math.round(u.percent)}%` : '…'}
      </span>
    );
  return null;
}
