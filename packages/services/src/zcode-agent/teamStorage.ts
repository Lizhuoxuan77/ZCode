// ============================================================
// Team storage — 桌面端侧的团队数据位置
// ============================================================
// 团队数据由 agent 写在 ZCode 用户数据目录（默认 `~/.zcode/cli/teams/<slug>-<hash>`），
// 不再写进用户项目。桌面端只做只读投影与“创建团队”写配置，必须用同一套路径规则；
// 规则本体在 `@zcode/shared/node`，这里只负责把它接上桌面端的数据根。
//
// 远程工作区不在本机用户目录里：agent 在远端机器上写自己的目录，桌面端既不读也不建，
// 否则会出现“本地创建成功、远端 agent 看不见”的假成功。

import { join } from "node:path";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { resolveTeamStoragePaths, type TeamStoragePaths } from "@zcode/shared/node";
import { getZCodeDataRootDir } from "../paths.js";

export interface TeamStorageTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export function isRemoteTeamWorkspace(target: TeamStorageTarget): boolean {
  const identity = target.workspaceIdentity?.trim();
  return identity !== undefined && identity.length > 0 && isRemoteWorkspaceIdentity(identity);
}

export function resolveDesktopTeamStorage(target: TeamStorageTarget): TeamStoragePaths {
  return resolveTeamStoragePaths({
    // 与 CLI 默认的 `~/.zcode/cli` 对齐；项目长期记忆也按同一约定定位。
    cliStorageRoot: join(getZCodeDataRootDir(), "cli"),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
  });
}
