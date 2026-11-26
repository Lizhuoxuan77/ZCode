// ============================================================
// Team config — 团队配置的共享形状、默认值与解析
// ============================================================
// team.json 的读写双方（桌面端服务层 / CLI agent 侧）必须对齐同一份字段与回退值：
// 桌面端负责创建与展示配置，CLI 负责按配置起调度。默认值只在这里定义一次，
// 避免两侧各写一套 positiveInt/nonNegativeInt 导致读写漂移。
//
// 本文件必须是 renderer 安全的纯 TS：不引 node:fs、不做 IO，只做结构与数值归一化。

export interface TeamLimitsView {
  /** 全队人数上限（含主管）。 */
  maxMembers: number;
  /** 组织树最大深度。主管 depth=0。 */
  maxDepth: number;
  /** 单次打回上限。到顶必须升级。 */
  maxRevisions: number;
  /** 问答链跳数上限。 */
  maxQuestionHops: number;
}

export interface TeamSupervisorView {
  name: string;
  purpose: string;
}

export interface TeamConfigView {
  name: string;
  supervisor: TeamSupervisorView;
  limits: TeamLimitsView;
  /** 同时在跑的成员数。 */
  concurrency: number;
  /** 整次交付的墙钟上限，0 表示不限。 */
  maxDurationMs: number;
  /** 单个成员一轮的上限。 */
  turnTimeoutMs: number;
  /** 看门狗阈值：连续无输出多久判卡住，0 关闭。 */
  stallTimeoutMs: number;
}

export const DEFAULT_TEAM_LIMITS_VIEW: TeamLimitsView = {
  maxMembers: 8,
  maxDepth: 3,
  maxRevisions: 1,
  maxQuestionHops: 3,
};

const POSITIVE_FALLBACKS = {
  concurrency: 2,
  maxDurationMs: 2 * 60 * 60_000,
  turnTimeoutMs: 30 * 60_000,
  stallTimeoutMs: 10 * 60_000,
} as const;

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** 0 是合法值（不限 / 关闭看门狗），不能当作缺省吞掉。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 把任意来源（磁盘 JSON / UI patch）的 team.json 归一化成完整配置。
 * 坏字段静默回退默认值——团队功能不该因为一个逗号让会话起不来。
 */
export function normalizeTeamConfig(raw: unknown): TeamConfigView {
  const source = asRecord(raw);
  const limits = asRecord(source.limits);
  const supervisor = asRecord(source.supervisor);
  return {
    name: nonEmptyString(source.name, "团队"),
    supervisor: {
      name: nonEmptyString(supervisor.name, "主管"),
      purpose: nonEmptyString(supervisor.purpose, "接需求、组队、验收、向用户交付"),
    },
    limits: {
      maxMembers: positiveInt(limits.maxMembers, DEFAULT_TEAM_LIMITS_VIEW.maxMembers),
      maxDepth: positiveInt(limits.maxDepth, DEFAULT_TEAM_LIMITS_VIEW.maxDepth),
      maxRevisions: nonNegativeInt(limits.maxRevisions, DEFAULT_TEAM_LIMITS_VIEW.maxRevisions),
      maxQuestionHops: positiveInt(
        limits.maxQuestionHops,
        DEFAULT_TEAM_LIMITS_VIEW.maxQuestionHops,
      ),
    },
    concurrency: positiveInt(source.concurrency, POSITIVE_FALLBACKS.concurrency),
    // 0 = 不限，必须用 nonNegativeInt，否则会被 positiveInt 当成缺省。
    maxDurationMs: nonNegativeInt(source.maxDurationMs, POSITIVE_FALLBACKS.maxDurationMs),
    turnTimeoutMs: positiveInt(source.turnTimeoutMs, POSITIVE_FALLBACKS.turnTimeoutMs),
    stallTimeoutMs: nonNegativeInt(source.stallTimeoutMs, POSITIVE_FALLBACKS.stallTimeoutMs),
  };
}
