import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamSyncStatus } from '../../shared/protocol';
import { api } from '../api';
import type { CanvasHost } from '../canvas/host';

interface SyncResult {
  ok: boolean;
  changed: boolean;
  message: string;
}

export function useTeamSync(project: string | undefined, branch: string | undefined, host: CanvasHost, paused: boolean, afterSync: (changed: boolean) => Promise<void>) {
  const [settings, setSettings] = useState<{ project: string; value: TeamSyncStatus }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const active = useRef(false);
  const checking = useRef(false);
  const status = settings?.project === project && settings?.value.branch === branch ? settings?.value : undefined;
  const auto = !!status?.branch && status.enabledBranch === status.branch && !status.reason;
  useEffect(() => {
    if (!project || !branch) return;
    let live = true;
    void api<TeamSyncStatus>('/api/git/team').then((value) => {
      if (live) setSettings({ project, value });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [project, branch]);

  const sync = useCallback(async (automatic: boolean) => {
    if (!project || !status?.branch || status.reason || active.current) return;
    if (paused || !host.canSync()) {
      if (!automatic) setNotice({ text: 'Finish the current edit before syncing.', error: true });
      return;
    }
    const root = host.stage.closest<HTMLElement>('.app');
    active.current = true;
    setBusy(true);
    if (root) root.inert = true;
    try {
      await host.flush();
      const result = await api<SyncResult>('/api/git/team/sync', { project, branch: status.branch, automatic });
      if (result.changed) await host.load();
      if (result.ok) await afterSync(result.changed);
      setNotice({ text: result.message, error: !result.ok });
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    } finally {
      if (root) root.inert = false;
      active.current = false;
      setBusy(false);
    }
  }, [project, status, paused, host, afterSync]);

  useEffect(() => {
    if (!project || !status?.branch || !auto || paused) return;
    let live = true;
    const branch = status.branch;
    const check = async () => {
      if (document.visibilityState !== 'visible' || checking.current || active.current || !host.canSync()) return;
      checking.current = true;
      try {
        await host.flush();
        const { needed } = await api<{ needed: boolean }>('/api/git/team/check', { project, branch });
        if (live && needed) await sync(true);
      } catch (error) {
        if (live) setNotice({ text: (error as Error).message, error: true });
      } finally {
        checking.current = false;
      }
    };
    const id = window.setInterval(() => { void check(); }, 30_000);
    return () => { live = false; window.clearInterval(id); };
  }, [auto, paused, sync, project, status?.branch, host]);

  const configure = async (enabled: boolean) => {
    if (!project || !status?.branch || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      const value = await api<TeamSyncStatus>('/api/git/team/settings', { branch: status.branch, enabled, project });
      setSettings({ project, value });
      setNotice({ text: enabled ? `Automatic sync enabled for ${status.branch}.` : 'Automatic sync is off.', error: false });
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { status, auto, busy, notice, sync, configure };
}
