// 团队数据在用户目录里：路径必须稳定、按工作区隔离，旧版本写在项目里的文件要能一次搬过来。
// 这里用真实临时目录验证路径与迁移，不依赖 agent 进程。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTeamStoragePaths } from "@zcode/shared/node";
import { migrateLegacyTeamStorage } from "../src/team/team-storage.js";

const dirs: string[] = [];

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
});

describe("team storage paths", () => {
  it("同一个工作区 + 同一个存储根得到同一个目录，且落在 teams 下", () => {
    const input = {
      cliStorageRoot: "/home/me/.zcode/cli",
      workspacePath: "/work/app",
    };

    const first = resolveTeamStoragePaths(input);
    const second = resolveTeamStoragePaths(input);

    expect(first.root).toBe(second.root);
    expect(basename(first.root).startsWith("app-")).toBe(true);
    expect(first.configPath).toBe(join(first.root, "team.json"));
    expect(first.databasePath).toBe(join(first.root, "team.db"));
    expect(first.memoryDir).toBe(join(first.root, "memory"));
  });

  it("身份优先于路径：不同身份即使路径相同也分目录", () => {
    const local = resolveTeamStoragePaths({
      cliStorageRoot: "/home/me/.zcode/cli",
      workspacePath: "/work/app",
    });
    const remote = resolveTeamStoragePaths({
      cliStorageRoot: "/home/me/.zcode/cli",
      workspacePath: "/work/app",
      workspaceIdentity: "remote:ssh:box:22:me:/work/app",
    });

    expect(remote.root).not.toBe(local.root);
    expect(basename(remote.root).startsWith("project-")).toBe(true);
  });
});

describe("legacy team storage migration", () => {
  it("把旧位置的文件搬到用户目录，并在成功后清理旧文件", () => {
    const workspace = newDir("zcode-team-legacy-workspace-");
    const userRoot = newDir("zcode-team-user-root-");
    const legacyTeamDir = join(workspace, ".zcode", "team");
    mkdirSync(join(legacyTeamDir, "memory"), { recursive: true });
    writeFileSync(join(workspace, ".zcode", "team.json"), '{"name":"旧团队"}', "utf8");
    writeFileSync(join(legacyTeamDir, "team.db"), "db-bytes", "utf8");
    writeFileSync(join(legacyTeamDir, "team.db-wal"), "wal-bytes", "utf8");
    writeFileSync(join(legacyTeamDir, "memory", "组长.md"), "旧记忆", "utf8");

    const storage = resolveTeamStoragePaths({
      cliStorageRoot: join(userRoot, "cli"),
      workspacePath: workspace,
    });
    const log = logger();

    migrateLegacyTeamStorage({ workspacePath: workspace, storage, logger: log as never });

    expect(readFileSync(storage.configPath, "utf8")).toBe('{"name":"旧团队"}');
    expect(readFileSync(storage.databasePath, "utf8")).toBe("db-bytes");
    expect(readFileSync(`${storage.databasePath}-wal`, "utf8")).toBe("wal-bytes");
    expect(readFileSync(join(storage.memoryDir, "组长.md"), "utf8")).toBe("旧记忆");
    expect(existsSync(join(workspace, ".zcode", "team.json"))).toBe(false);
    expect(existsSync(legacyTeamDir)).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("migrated"),
      expect.objectContaining({ root: storage.root }),
    );
  });

  it("重复调用是幂等的，且不覆盖用户目录里已有的记忆", () => {
    const workspace = newDir("zcode-team-legacy-repeat-");
    const userRoot = newDir("zcode-team-user-repeat-");
    mkdirSync(join(workspace, ".zcode", "team", "memory"), { recursive: true });
    writeFileSync(join(workspace, ".zcode", "team.json"), '{"name":"旧团队"}', "utf8");
    writeFileSync(join(workspace, ".zcode", "team", "memory", "组长.md"), "旧记忆", "utf8");

    const storage = resolveTeamStoragePaths({
      cliStorageRoot: join(userRoot, "cli"),
      workspacePath: workspace,
    });
    mkdirSync(storage.memoryDir, { recursive: true });
    writeFileSync(join(storage.memoryDir, "组长.md"), "新记忆", "utf8");

    migrateLegacyTeamStorage({ workspacePath: workspace, storage, logger: logger() as never });
    migrateLegacyTeamStorage({ workspacePath: workspace, storage, logger: logger() as never });

    expect(readFileSync(join(storage.memoryDir, "组长.md"), "utf8")).toBe("新记忆");
    expect(readFileSync(storage.configPath, "utf8")).toBe('{"name":"旧团队"}');
  });

  it("没有旧配置的普通项目不会产生任何团队目录", () => {
    const workspace = newDir("zcode-team-plain-workspace-");
    const userRoot = newDir("zcode-team-user-plain-");
    const storage = resolveTeamStoragePaths({
      cliStorageRoot: join(userRoot, "cli"),
      workspacePath: workspace,
    });

    migrateLegacyTeamStorage({ workspacePath: workspace, storage, logger: logger() as never });

    expect(existsSync(storage.root)).toBe(false);
  });

  it("用户目录已经建过团队时，旧文件不并入也不删除", () => {
    const workspace = newDir("zcode-team-legacy-conflict-");
    const userRoot = newDir("zcode-team-user-conflict-");
    mkdirSync(join(workspace, ".zcode", "team", "memory"), { recursive: true });
    writeFileSync(join(workspace, ".zcode", "team.json"), '{"name":"旧团队"}', "utf8");
    mkdirSync(join(workspace, ".zcode", "team", "memory"), { recursive: true });
    writeFileSync(join(workspace, ".zcode", "team", "memory", "组长.md"), "旧记忆", "utf8");

    const storage = resolveTeamStoragePaths({
      cliStorageRoot: join(userRoot, "cli"),
      workspacePath: workspace,
    });
    mkdirSync(storage.root, { recursive: true });
    writeFileSync(storage.configPath, '{"name":"新团队"}', "utf8");

    const log = logger();
    migrateLegacyTeamStorage({ workspacePath: workspace, storage, logger: log as never });

    expect(readFileSync(storage.configPath, "utf8")).toBe('{"name":"新团队"}');
    expect(existsSync(join(storage.memoryDir, "组长.md"))).toBe(false);
    expect(existsSync(join(workspace, ".zcode", "team.json"))).toBe(true);
  });
});
