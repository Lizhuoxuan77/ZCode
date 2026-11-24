// ============================================================
// 创建团队：把「写一个 JSON 文件」变成面板上的一个按钮
// ============================================================
// 团队配置属于 ZCode 的本机运行数据，写在用户数据目录（`teams/<slug>-<hash>/team.json`），
// 不写进用户项目。以前要用户手写项目里的 `.zcode/team.json`，那不是产品行为，也会污染仓库。
// 这里只做一件事：按团队名生成一份最小可用配置。
//
// 三条约束：
//   1. **不覆盖已有配置**。用户可能手改过 limits/supervisor，界面不该悄悄盖掉它。
//   2. **只写配置，不启动**。创建团队 ≠ 派任务；起跑由用户点「派任务」决定。
//   3. 写入后由调用方重新读快照即可生效——配置读取已改为每次重读，不需要重启会话。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
