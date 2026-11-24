// ============================================================
// Team member memory — 界面侧的只读投影
// ============================================================
// 记忆的真身是 ZCode 用户数据目录里 `teams/<slug>-<hash>/memory/<名字>.md`，
// 由成员通过 SaveMemory 工具写入（agent 自己总结要点）；调度器只读，不再自动追加。
// 它不写进用户项目，所以这里必须和 agent 用同一套路径规则定位。
//
// 渲染进程读不到文件系统，所以这里提供一条**按需**通路：用户点开某个成员时才读。
// 只读尾部而不是全文——记忆是时间线，越新越有意义，而文件会随轮次无限增长。
//
// 三条约束与 teamSnapshot 一致：只读、不缓存、任何异常降级为空（界面显示空态即可）。

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isRemoteTeamWorkspace, resolveDesktopTeamStorage } from "./teamStorage.js";

/** 默认只读尾部 16k 字符：够覆盖几十轮的「收到什么 → 结果」。 */
const DEFAULT_CHAR_LIMIT = 16_000;
const MIN_CHAR_LIMIT = 500;
const MAX_CHAR_LIMIT = 60_000;

export interface ZCodeTeamMemberMemoryParams {
  workspacePath: string;
  /** 远程身份优先于路径；用于定位同一个工作区的团队数据。 */
  workspaceIdentity?: string;
  memberName: string;
  /** 最多读多少字符（取尾部）。默认 16000。 */
  limit?: number;
}

export interface ZCodeTeamMemberMemoryResult {
  /** 记忆文件绝对路径；界面直接展示，方便查看完整记录。 */
  path: string;
  /** 文件是否存在。false 表示这个成员还没被唤醒过，或名字对不上。 */
  exists: boolean;
  /** 文件尾部文本（可能被截断）。 */
  text: string;
  /** 文件总字符数，用于展示「共 3.2k 字」，也让截断可解释。 */
  chars: number;
  truncated: boolean;
  /** 最后写入时间。 */
  updatedAt?: number;
}

/**
 * 与 bootstrap 侧 `safeName` 保持逐字一致。
 * 两处命名规则一旦漂移，界面就会读不到文件而表现为「记忆丢了」——所以这里是复制而非各自实现。
 */
function safeMemberFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "member";
}

function emptyResult(file: string): ZCodeTeamMemberMemoryResult {
  return { path: file, exists: false, text: "", chars: 0, truncated: false };
}

export function readTeamMemberMemory(
  params: ZCodeTeamMemberMemoryParams,
): ZCodeTeamMemberMemoryResult {
  const storage = resolveDesktopTeamStorage(params);
  const memoryDir = resolve(storage.memoryDir);
  const file = resolve(memoryDir, `${safeMemberFileName(params.memberName)}.md`);
  // 名字已经过清洗，理论上不可能越界；但路径是多来源拼出来的，越界就直接拒绝而不是读它。
  if (!file.startsWith(`${memoryDir}${sep}`)) return emptyResult(file);
  // 远程工作区的记忆在远端机器的用户目录里，本机读到的是不存在；直接空态，不误读本地同名键。
  if (isRemoteTeamWorkspace(params)) return emptyResult(file);

  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_CHAR_LIMIT, MIN_CHAR_LIMIT),
    MAX_CHAR_LIMIT,
  );

  try {
    if (!existsSync(file)) return emptyResult(file);
    const raw = readFileSync(file, "utf8");
    const chars = raw.length;
    return {
      path: file,
      exists: true,
      text: chars > limit ? raw.slice(-limit) : raw,
      chars,
      truncated: chars > limit,
      updatedAt: statSync(file).mtimeMs,
    };
  } catch {
    // 读不到不该让面板炸掉：记忆只是上下文，不是事实源。
    return emptyResult(file);
  }
}
