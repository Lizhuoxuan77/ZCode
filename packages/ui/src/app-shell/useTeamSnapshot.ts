import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeTeamSnapshot } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";

/**
 * 团队快照轮询。架构图与侧栏面板读的是同一份只读投影，所以共用这一个 hook：
 * 两份轮询会让同一个库在 2 秒内被读两次，且两处「上一次读到什么」会互相打脸。
 */
export const TEAM_SNAPSHOT_POLL_INTERVAL_MS = 2_000;

export interface UseTeamSnapshotResult {
  snapshot: ZCodeTeamSnapshot | undefined;
  /** 只在「一次都没读到」时有意义；有快照后的失败静默重试，避免把面板刷成报错页。 */
  error: string | undefined;
  /** 每轮轮询推进一次，用来把「已运行 12 分」算成活的。 */
  now: number;
  reload: () => Promise<void>;
}

export function useTeamSnapshot(
  workspacePath: string,
  options: { messageLimit?: number; enabled?: boolean } = {},
): UseTeamSnapshotResult {
  const { zcodeAgentService } = useServices();
  const [snapshot, setSnapshot] = useState<ZCodeTeamSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);
  const enabled = options.enabled ?? true;
  const messageLimit = options.messageLimit ?? 60;

  const load = useCallback(async () => {
    try {
      const next = await zcodeAgentService.getTeamSnapshot({ workspacePath, messageLimit });
      if (!aliveRef.current) return;
      setSnapshot(next);
      setError(undefined);
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [messageLimit, workspacePath, zcodeAgentService]);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) {
      return () => {
        aliveRef.current = false;
      };
    }
    void load();
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, TEAM_SNAPSHOT_POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [enabled, load]);

  return { snapshot, error, now, reload: load };
}
