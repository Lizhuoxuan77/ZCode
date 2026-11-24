// ============================================================
// Team storage paths — 团队数据在用户目录里的唯一位置
// ============================================================
// 团队数据不属于用户的项目仓库：配置、运行数据库、成员记忆都放在 ZCode 的用户数据目录，
// 按工作区身份分目录。CLI（agent 侧，负责写）与桌面端（只读投影）必须算出同一个路径，
// 所以解析规则只在这里实现一次，两边都从 @zcode/shared/node 引用。
//
// 键规则与现有“项目长期记忆”一致：workspaceIdentity 优先，否则用规范化后的工作区路径
// （Windows 转小写）。目录名是「清洗后的项目名-哈希」，方便用户按项目找到它。

import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

export const TEAM_CONFIG_FILE_NAME = "team.json";
export const TEAM_DATABASE_FILE_NAME = "team.db";
export const TEAM_MEMORY_DIRECTORY_NAME = "memory";
const TEAM_STORAGE_DIRECTORY_NAME = "teams";

export interface TeamStoragePathsInput {
  /**
   * ZCode 用户数据目录下的 CLI 存储根。
   * agent 侧用它已有的 CLI storage root（默认 `~/.zcode/cli`）；桌面端用 `<应用数据根>/.zcode/cli`，
   * 与现有“项目长期记忆”的目录约定保持一致。
   */
  cliStorageRoot: string;
  /** 工作区路径：只用于计算身份键，不会被当作存储位置。 */
  workspacePath: string;
  /** 远程工作区身份；有值时优先于路径，且目录名固定用 project。 */
  workspaceIdentity?: string;
}

export interface TeamStoragePaths {
  /** `<cliStorageRoot>/teams/<slug>-<hash>` */
  root: string;
  /** 团队配置（替代项目里的 .zcode/team.json）。 */
  configPath: string;
  /** 运行数据库；WAL 与其同目录。 */
  databasePath: string;
  /** 成员记忆目录。 */
  memoryDir: string;
}

/** 旧版本写在项目里的团队文件；只用于一次性迁移。 */
export interface LegacyTeamWorkspacePaths {
  /** `<workspace>/.zcode/team.json` */
  configPath: string;
  /** `<workspace>/.zcode/team` */
  teamDir: string;
  /** `<workspace>/.zcode/team/team.db` */
  databasePath: string;
  /** `<workspace>/.zcode/team/memory` */
  memoryDir: string;
}

export function resolveTeamStoragePaths(input: TeamStoragePathsInput): TeamStoragePaths {
  const root = join(
    input.cliStorageRoot,
    TEAM_STORAGE_DIRECTORY_NAME,
    teamWorkspaceDirectoryName(input),
  );
  return {
    root,
    configPath: join(root, TEAM_CONFIG_FILE_NAME),
    databasePath: join(root, TEAM_DATABASE_FILE_NAME),
    memoryDir: join(root, TEAM_MEMORY_DIRECTORY_NAME),
  };
}

export function resolveLegacyTeamWorkspacePaths(workspacePath: string): LegacyTeamWorkspacePaths {
  const workspaceRoot = resolve(workspacePath);
  const teamDir = join(workspaceRoot, ".zcode", "team");
  return {
    configPath: join(workspaceRoot, ".zcode", TEAM_CONFIG_FILE_NAME),
    teamDir,
    databasePath: join(teamDir, TEAM_DATABASE_FILE_NAME),
    memoryDir: join(teamDir, TEAM_MEMORY_DIRECTORY_NAME),
  };
}

function teamWorkspaceDirectoryName(input: TeamStoragePathsInput): string {
  const identity = input.workspaceIdentity?.trim();
  const normalizedWorkspacePath = resolve(input.workspacePath);
  // 远程身份可能带大小写不同的主机名；身份本身是协议值，不做路径规范化。
  const keySource =
    identity ||
    (process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = identity ? "project" : sanitizeProjectSlug(basename(normalizedWorkspacePath));
  return `${slug}-${hash}`;
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
