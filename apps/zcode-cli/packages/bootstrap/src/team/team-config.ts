// ============================================================
// Team Config — 项目里的团队声明
// ============================================================
// 团队属于 workspace，不属于某次会话：同一个项目的多个窗口共享同一批人，
// 切换 workspace 等于换团队。所以配置和状态都在项目的 `.zcode/` 下。
//
// `.zcode/team.json` 是**唯一开关**：没有这个文件，团队工具根本不注册，
// 老用户感觉不到任何变化。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TEAM_LIMITS, type TeamLimits } from "@zcode/contracts";

export const TEAM_CONFIG_RELATIVE_PATH = join(".zcode", "team.json");
export const TEAM_DB_RELATIVE_PATH = join(".zcode", "team", "team.db");

export interface TeamConfig {
  /** 团队名，用于日志与会话标题。 */
  name: string;
  supervisor: { name: string; purpose: string };
  limits: TeamLimits;
  /** 同时在跑的成员数。默认 2：再多也不会更快，只会更容易撞同一个文件。 */
  concurrency: number;
  /** 整次交付的硬上限。 */
  maxDurationMs: number;
}

interface RawConfig {
  name?: unknown;
  supervisor?: { name?: unknown; purpose?: unknown };
  limits?: Partial<Record<keyof TeamLimits, unknown>>;
  concurrency?: unknown;
  maxDurationMs?: unknown;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 缺字段就用默认值，坏文件当没有——团队功能不该因为一个逗号让整个会话起不来。 */
export function loadTeamConfig(workingDirectory: string): TeamConfig | undefined {
  const path = join(workingDirectory, TEAM_CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return undefined;
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch {
    return undefined;
  }

  const limits = raw.limits ?? {};
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "团队",
    supervisor: {
      name:
        typeof raw.supervisor?.name === "string" && raw.supervisor.name.trim()
          ? raw.supervisor.name.trim()
          : "主管",
      purpose:
        typeof raw.supervisor?.purpose === "string" && raw.supervisor.purpose.trim()
          ? raw.supervisor.purpose.trim()
          : "接需求、组队、验收、向用户交付",
    },
    limits: {
      maxMembers: positiveInt(limits.maxMembers, DEFAULT_TEAM_LIMITS.maxMembers),
      maxDepth: positiveInt(limits.maxDepth, DEFAULT_TEAM_LIMITS.maxDepth),
      maxRevisions:
        typeof limits.maxRevisions === "number" && limits.maxRevisions >= 0
          ? Math.floor(limits.maxRevisions)
          : DEFAULT_TEAM_LIMITS.maxRevisions,
      maxQuestionHops: positiveInt(limits.maxQuestionHops, DEFAULT_TEAM_LIMITS.maxQuestionHops),
    },
    concurrency: positiveInt(raw.concurrency, 2),
    maxDurationMs: positiveInt(raw.maxDurationMs, 30 * 60_000),
  };
}

export function teamDatabasePath(workingDirectory: string): string {
  const path = join(workingDirectory, TEAM_DB_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
