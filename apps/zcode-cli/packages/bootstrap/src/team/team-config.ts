// ============================================================
// Team Config — ZCode 用户目录里的团队声明
// ============================================================
// 团队属于 workspace，不属于某次会话：同一个项目的多个窗口共享同一批人，
// 切换 workspace 等于换团队。但配置和状态**不写在用户项目里**——它们属于本机运行数据，
// 统一放在 ZCode 用户数据目录（按工作区身份分目录）。
//
// `team.json` 是**唯一开关**：没有这个文件，团队工具就不会真正接活，
// 老用户感觉不到任何变化。

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_TEAM_LIMITS, type TeamLimits } from "@zcode/contracts";

export interface TeamConfig {
  /** 团队名，用于日志与会话标题。 */
  name: string;
  supervisor: { name: string; purpose: string };
  limits: TeamLimits;
  /** 同时在跑的成员数。默认 2：再多也不会更快，只会更容易撞同一个文件。 */
  concurrency: number;
  /**
   * 整次交付的硬上限，`0` 表示不限。
   *
   * 墙钟不是「失控」的判据：正常推进的团队跑几小时是健康的，卡死的团队该在几分钟内被发现。
   * 按时长设上限只会砍掉真实的大任务（4 人做一个完整游戏，光轮次折算就要 75–150 分钟）。
   * 真正的兜底是停滞检测与单轮上限；这里留一个默认值只为防「僵尸团队把主会话永久挂住」。
   */
  maxDurationMs: number;
  /** 单个成员一轮的上限。写整套代码或一批文档需要比 15 分钟更宽。 */
  turnTimeoutMs: number;
  /**
   * 看门狗阈值：一个成员连续多久**没有任何输出**就判卡住。`0` 关闭看门狗。
   *
   * 这是活性判据而不是时长判据——一直在写文件的人可以跑很久，一个 chunk 都没有才是卡住。
   */
  stallTimeoutMs: number;
}

interface RawConfig {
  name?: unknown;
  supervisor?: { name?: unknown; purpose?: unknown };
  limits?: Partial<Record<keyof TeamLimits, unknown>>;
  concurrency?: unknown;
  maxDurationMs?: unknown;
  turnTimeoutMs?: unknown;
  stallTimeoutMs?: unknown;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** `0` 是合法值（表示不限），所以不能用 positiveInt：那会把 0 当成缺省。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 缺字段就用默认值，坏文件当没有——团队功能不该因为一个逗号让整个会话起不来。 */
export function loadTeamConfig(configPath: string): TeamConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;
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
    // 默认 2 小时：比旧的 30 分钟宽到能跑真实交付，又保留一个「僵尸团队不会永久挂住主会话」的保险。
    maxDurationMs: nonNegativeInt(raw.maxDurationMs, 2 * 60 * 60_000),
    // 单轮 30 分钟：15 分钟写不完「一套代码 + 构建配置」或「4 个文档」，被砍一次就要从头重规划。
    turnTimeoutMs: positiveInt(raw.turnTimeoutMs, 30 * 60_000),
    // 10 分钟没有任何输出才算卡住：一次模型请求加一轮工具调用的正常间隔远小于它，
    // 而真正的死锁（等一个永不返回的请求）也在这个量级上暴露出来。
    stallTimeoutMs: nonNegativeInt(raw.stallTimeoutMs, 10 * 60_000),
  };
}
