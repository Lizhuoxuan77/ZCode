// ============================================================
// 创建团队：把「写一个 JSON 文件」变成面板上的一个按钮
// ============================================================
// 团队配置是 workspace 级的开关（`.zcode/team.json`）。以前要用户手写它，那不是产品行为。
// 这里只做一件事：按团队名生成一份最小可用配置。
//
// 三条约束：
//   1. **不覆盖已有配置**。用户可能手改过 limits/supervisor，界面不该悄悄盖掉它。
//   2. **只写配置，不启动**。创建团队 ≠ 派任务；起跑由用户点「派任务」决定。
//   3. 写入后由调用方重新读快照即可生效——配置读取已改为每次重读，不需要重启会话。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ZCodeTeamConfigWriteParams {
  workspacePath: string;
  /** 团队名，用于面板标题与日志。 */
  name: string;
}

export interface ZCodeTeamConfigWriteResult {
  path: string;
  /** false 表示已经存在，本次没有覆盖。 */
  created: boolean;
}

export const TEAM_CONFIG_PATH_SEGMENTS = [".zcode", "team.json"] as const;

export function writeTeamConfig(params: ZCodeTeamConfigWriteParams): ZCodeTeamConfigWriteResult {
  const name = params.name.trim();
  if (!name) throw new Error("team name is required");
  const path = join(params.workspacePath, ...TEAM_CONFIG_PATH_SEGMENTS);
  if (existsSync(path)) return { path, created: false };

  mkdirSync(dirname(path), { recursive: true });
  const config = {
    name,
    supervisor: {
      name: "主管",
      purpose: "接需求、判断要哪些岗位、组织交付、向用户汇报",
    },
    limits: { maxMembers: 8, maxDepth: 3, maxRevisions: 1, maxQuestionHops: 3 },
    concurrency: 2,
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { path, created: true };
}
