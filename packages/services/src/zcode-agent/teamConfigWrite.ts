// ============================================================
// 创建团队 / 团队配置读写：把「写一个 JSON 文件」变成面板上的操作
// ============================================================
// 团队配置属于 ZCode 的本机运行数据，写在用户数据目录（`teams/<slug>-<hash>/team.json`），
// 不写进用户项目。以前要用户手写项目里的 `.zcode/team.json`，那不是产品行为，也会污染仓库。
//
// 三条约束：
//   1. **创建不覆盖**。writeTeamConfig 是 create-only：用户可能手改过 limits/supervisor，创建不该盖掉它。
//   2. **修改走 update**。创建后的配置修改统一走 updateTeamConfig：读旧配置 → 字段白名单校验 → 原子合并写回，
//      保留未知字段与 name/supervisor。UI 不直接碰文件。
//   3. **读写共用一套默认值**。normalizeTeamConfig 在 @zcode/shared，CLI 读取侧也用它，杜绝漂移。
//
// 写入后由调用方重新读快照即可生效——配置读取已改为每次重读，不需要重启会话。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  normalizeTeamConfig,
  type TeamConfigView,
} from "@zcode/shared";
import { isRemoteTeamWorkspace, resolveDesktopTeamStorage } from "./teamStorage.js";

export interface ZCodeTeamConfigWriteParams {
  workspacePath: string;
  /** 远程身份优先于路径；用于定位同一个工作区的团队数据。 */
  workspaceIdentity?: string;
  /** 团队名，用于面板标题与日志。 */
  name: string;
}

export interface ZCodeTeamConfigWriteResult {
  path: string;
  /** false 表示已经存在，本次没有覆盖。 */
  created: boolean;
}

export interface ZCodeTeamConfigTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ZCodeTeamConfigResult {
  path: string;
  /** 当前生效配置（已归一化，含默认值）。配置不存在时为 undefined。 */
  config?: TeamConfigView;
}

/** 面板可改的字段白名单。name/supervisor/未知字段原样保留，不在此列。 */
export interface TeamConfigPatch {
  concurrency?: unknown;
  maxDurationMs?: unknown;
  turnTimeoutMs?: unknown;
  stallTimeoutMs?: unknown;
  limits?: {
    maxMembers?: unknown;
    maxDepth?: unknown;
    maxRevisions?: unknown;
    maxQuestionHops?: unknown;
  };
}

function readConfigFile(path: string): TeamConfigView | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return normalizeTeamConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    // 坏文件当没有：团队功能不该因为一个逗号起不来。
    return undefined;
  }
}

/** 读原始 JSON（未归一化），用于合并时保留未知字段。 */
function readRawConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 原子写：先写同目录临时文件再 rename，避免中途崩溃留下半份 JSON。 */
function atomicWriteJson(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

export function writeTeamConfig(params: ZCodeTeamConfigWriteParams): ZCodeTeamConfigWriteResult {
  // 远程工作区的团队数据必须由远端 agent 写进远端用户目录；桌面端写本地目录只会造成
  // 「创建成功但 agent 看不见」的假成功，所以这里明确拒绝。
  if (isRemoteTeamWorkspace(params)) {
    throw new Error("团队数据只保存在本机用户目录，远程工作区暂不支持创建团队。");
  }
  const name = params.name.trim();
  if (!name) throw new Error("team name is required");
  const path = resolveDesktopTeamStorage(params).configPath;
  if (existsSync(path)) return { path, created: false };

  mkdirSync(dirname(path), { recursive: true });
  const config: TeamConfigView = normalizeTeamConfig({ name });
  atomicWriteJson(path, config);
  return { path, created: true };
}

/** 读当前团队配置（远程工作区返回 undefined，与快照一致）。 */
export function readTeamConfig(params: ZCodeTeamConfigTarget): ZCodeTeamConfigResult {
  if (isRemoteTeamWorkspace(params)) return { path: "" };
  const path = resolveDesktopTeamStorage(params).configPath;
  return { path, config: readConfigFile(path) };
}

/**
 * 更新当前团队配置：只读合法字段，按字段白名单校验后合并写回。
 * 团队不存在（配置未创建）时抛错——避免误创建一个空团队。
 */
export function updateTeamConfig(
  params: ZCodeTeamConfigTarget,
  patch: TeamConfigPatch,
): ZCodeTeamConfigResult {
  if (isRemoteTeamWorkspace(params)) {
    throw new Error("团队数据只保存在本机用户目录，远程工作区暂不支持修改团队配置。");
  }
  const path = resolveDesktopTeamStorage(params).configPath;
  if (!readConfigFile(path)) throw new Error("团队尚未创建，请先创建团队再修改配置。");
  // 以原始 JSON 为合并底稿，保留未知字段与 name/supervisor；归一化只用于校验与返回视图。
  const raw = readRawConfig(path) ?? {};
  // team.json 是用户可手改的文件，limits 可能是字符串甚至数组。保留未知字段时只认对象形态，
  // 否则 `{ ...raw.limits }` 会把 "abc" 展开成 {0:"a",1:"b",2:"c"} 写回磁盘。
  const rawLimits: Record<string, unknown> =
    typeof raw.limits === "object" && raw.limits !== null && !Array.isArray(raw.limits)
      ? (raw.limits as Record<string, unknown>)
      : {};

  // 把 patch 里的合法字段叠加到已有配置上，再整体交给 normalizeTeamConfig 校验——
  // 只影响显式传入的字段，非法值按共享规则回退到默认值（见 zcode-team-config.ts）。
  const merged: Record<string, unknown> = { ...raw };
  if (patch.concurrency !== undefined) merged.concurrency = patch.concurrency;
  if (patch.maxDurationMs !== undefined) merged.maxDurationMs = patch.maxDurationMs;
  if (patch.turnTimeoutMs !== undefined) merged.turnTimeoutMs = patch.turnTimeoutMs;
  if (patch.stallTimeoutMs !== undefined) merged.stallTimeoutMs = patch.stallTimeoutMs;
  if (patch.limits) {
    const limits: Record<string, unknown> = { ...rawLimits };
    for (const key of ["maxMembers", "maxDepth", "maxRevisions", "maxQuestionHops"] as const) {
      const value = patch.limits[key];
      if (value !== undefined) limits[key] = value;
    }
    merged.limits = limits;
  }
  const config = normalizeTeamConfig(merged);
  // 写回归一化后的值，但把原始 JSON 里的未知字段原样带上（top-level 与 limits 两层）。
  const toWrite: Record<string, unknown> = {
    ...raw,
    ...config,
    limits: { ...rawLimits, ...config.limits },
  };
  atomicWriteJson(path, toWrite);
  return { path, config };
}
