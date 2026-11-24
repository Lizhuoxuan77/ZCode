// ============================================================
// Team Storage — 团队数据从项目目录迁到用户目录
// ============================================================
// 旧版本的团队配置、数据库和记忆写在 `<workspace>/.zcode/team`，会污染用户项目、可能被误提交，
// 数据库还可能落在同步盘上。新版本统一放在 ZCode 用户数据目录；这里在 agent 启动时做一次性迁移：
//   - 只有「新位置没有配置、旧位置有配置」才迁移，避免把旧数据混进新建的团队；
//   - 先复制数据库与记忆，最后复制配置（配置出现 = 迁移完成），中途失败下次启动还能重试；
//   - 复制成功后再删旧文件；删除失败只警告，不阻断启动。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { resolveLegacyTeamWorkspacePaths, type TeamStoragePaths } from "@zcode/shared/node";

export interface MigrateTeamStorageInput {
  workspacePath: string;
  storage: TeamStoragePaths;
  logger?: Logger;
}

export function migrateLegacyTeamStorage(input: MigrateTeamStorageInput): void {
  const legacy = resolveLegacyTeamWorkspacePaths(input.workspacePath);
  if (!existsSync(legacy.configPath)) return;
  if (existsSync(input.storage.configPath)) {
    // 新位置已经建过团队（例如用户先通过面板创建）：旧数据不再并入，避免两段历史混在一起。
    input.logger?.debug?.("Team storage already exists; legacy workspace files left untouched", {
      event: "team.storage.legacy_ignored",
      module: "bootstrap.team",
      root: input.storage.root,
    });
    return;
  }

  try {
    mkdirSync(input.storage.root, { recursive: true });
    mkdirSync(input.storage.memoryDir, { recursive: true });
    // WAL 与 shm 必须跟着主库一起复制：只拷 team.db 会丢掉尚未 checkpoint 的最近几轮。
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const source = `${legacy.databasePath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${input.storage.databasePath}${suffix}`);
    }
    if (existsSync(legacy.memoryDir)) {
      for (const entry of readdirSync(legacy.memoryDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const target = join(input.storage.memoryDir, entry.name);
        if (!existsSync(target)) copyFileSync(join(legacy.memoryDir, entry.name), target);
      }
    }
    // 配置最后复制：它的存在代表迁移完成；中途失败时下次启动会重新尝试。
    copyFileSync(legacy.configPath, input.storage.configPath);
  } catch (error) {
    input.logger?.warn?.("Team storage migration failed", {
      event: "team.storage.migrate_failed",
      module: "bootstrap.team",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    rmSync(legacy.configPath, { force: true });
    rmSync(legacy.teamDir, { recursive: true, force: true });
  } catch (error) {
    // 旧文件删不掉只是残留；新位置已经可用，不该让团队启动失败。
    input.logger?.warn?.("Legacy team files could not be removed", {
      event: "team.storage.legacy_cleanup_failed",
      module: "bootstrap.team",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  input.logger?.info?.("Team storage migrated to user data directory", {
    event: "team.storage.migrated",
    module: "bootstrap.team",
    root: input.storage.root,
  });
}
