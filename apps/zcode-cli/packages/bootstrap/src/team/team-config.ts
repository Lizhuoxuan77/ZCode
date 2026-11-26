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
import {
  normalizeTeamConfig,
  type TeamConfigView,
  type TeamLimitsView,
} from "@zcode/shared";

/** 与桌面端服务层共用同一份形状与默认值，避免读写两侧漂移。 */
export type TeamConfig = TeamConfigView;
export type TeamLimits = TeamLimitsView;

/** 缺字段就用默认值，坏文件当没有——团队功能不该因为一个逗号让整个会话起不来。 */
export function loadTeamConfig(configPath: string): TeamConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  return normalizeTeamConfig(raw);
}
