import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import {
  readTeamConfig,
  updateTeamConfig,
  writeTeamConfig,
} from "../src/zcode-agent/teamConfigWrite.js";
import { readTeamSnapshot } from "../src/zcode-agent/teamSnapshot.js";
import { readTeamMemberMemory } from "../src/zcode-agent/teamMemory.js";

const dirs: string[] = [];

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setDataBaseDir(null);
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
});

describe("desktop team storage", () => {
  it("创建团队写到用户目录，快照能读到配置，项目里不产生文件", () => {
    const dataBase = newDir("zcode-team-desktop-data-");
    const workspace = newDir("zcode-team-desktop-ws-");
    setDataBaseDir(dataBase);

    const written = writeTeamConfig({ workspacePath: workspace, name: "桌面团队" });

    expect(written.created).toBe(true);
    expect(written.path.startsWith(join(dataBase, ".zcode", "cli", "teams"))).toBe(true);
    expect(readFileSync(written.path, "utf8")).toContain("桌面团队");
    expect(existsSync(join(workspace, ".zcode"))).toBe(false);

    const snapshot = readTeamSnapshot({ workspacePath: workspace });
    expect(snapshot.configured).toBe(true);
    expect(snapshot.started).toBe(false);
    expect(snapshot.teamName).toBe("桌面团队");
    // 快照带出归一化后的配置，供面板表单读初值。
    expect(snapshot.config?.concurrency).toBe(2);
    expect(snapshot.config?.limits.maxMembers).toBe(8);
    expect(snapshot.config?.turnTimeoutMs).toBe(30 * 60_000);

    const memory = readTeamMemberMemory({ workspacePath: workspace, memberId: "tm_member_test" });
    expect(memory.exists).toBe(false);
    expect(memory.path.startsWith(join(dataBase, ".zcode", "cli", "teams"))).toBe(true);
    // 文件名取成员 id，不取名字：面板显示名与存储键解耦。
    expect(memory.path.endsWith("tm_member_test.md")).toBe(true);
  });

  it("远程工作区拒绝创建，快照保持空态", () => {
    const dataBase = newDir("zcode-team-desktop-remote-");
    const workspace = newDir("zcode-team-desktop-remote-ws-");
    setDataBaseDir(dataBase);
    const workspaceIdentity = "remote:ssh:box:22:me:/work/app";

    expect(() =>
      writeTeamConfig({ workspacePath: workspace, workspaceIdentity, name: "远端团队" }),
    ).toThrow(/远程工作区/);
    expect(readTeamSnapshot({ workspacePath: workspace, workspaceIdentity }).configured).toBe(
      false,
    );
  });

  it("读取配置：未创建返回 undefined，创建后返回归一化配置（含默认值）", () => {
    const dataBase = newDir("zcode-team-read-data-");
    const workspace = newDir("zcode-team-read-ws-");
    setDataBaseDir(dataBase);

    expect(readTeamConfig({ workspacePath: workspace }).config).toBeUndefined();

    const written = writeTeamConfig({ workspacePath: workspace, name: "读配置团队" });
    const config = readTeamConfig({ workspacePath: workspace }).config;
    expect(config?.name).toBe("读配置团队");
    expect(config?.concurrency).toBe(2);
    expect(config?.limits.maxMembers).toBe(8);
    expect(config?.maxDurationMs).toBe(2 * 60 * 60_000);
    expect(written.path).toBeTruthy();
  });

  it("更新配置：只改白名单字段，保留 name/supervisor/未知字段，超时换算正确", () => {
    const dataBase = newDir("zcode-team-update-data-");
    const workspace = newDir("zcode-team-update-ws-");
    setDataBaseDir(dataBase);
    const { path } = writeTeamConfig({ workspacePath: workspace, name: "待配置团队" });

    // 塞一个未知字段，验证合并时不被丢掉。
    const before = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...before, customField: "keep-me" }), "utf8");

    const result = updateTeamConfig(
      { workspacePath: workspace },
      {
        concurrency: 3,
        limits: { maxMembers: 5 },
        turnTimeoutMs: 45 * 60_000,
        stallTimeoutMs: 0,
      },
    );

    expect(result.config?.concurrency).toBe(3);
    expect(result.config?.limits.maxMembers).toBe(5);
    expect(result.config?.limits.maxDepth).toBe(3); // 未改字段保持默认
    expect(result.config?.turnTimeoutMs).toBe(45 * 60_000);
    expect(result.config?.stallTimeoutMs).toBe(0); // 0 合法，不被默认值吞掉
    expect(result.config?.name).toBe("待配置团队");
    expect(result.config?.supervisor.name).toBe("主管");

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.customField).toBe("keep-me");
    // 快照立即读到新值（配置每次重读）。
    expect(readTeamSnapshot({ workspacePath: workspace }).config?.concurrency).toBe(3);
  });

  it("更新配置：非法值回退默认，团队未创建与远程工作区抛错", () => {
    const dataBase = newDir("zcode-team-invalid-data-");
    const workspace = newDir("zcode-team-invalid-ws-");
    setDataBaseDir(dataBase);
    writeTeamConfig({ workspacePath: workspace, name: "校验团队" });

    const result = updateTeamConfig(
      { workspacePath: workspace },
      { concurrency: -1, limits: { maxMembers: 0 } },
    );
    // concurrency=-1 回退默认 2；maxMembers=0 回退默认 8。
    expect(result.config?.concurrency).toBe(2);
    expect(result.config?.limits.maxMembers).toBe(8);

    const otherWorkspace = newDir("zcode-team-no-team-ws-");
    expect(() => updateTeamConfig({ workspacePath: otherWorkspace }, { concurrency: 3 })).toThrow(
      /团队尚未创建/,
    );
    expect(() =>
      updateTeamConfig(
        { workspacePath: workspace, workspaceIdentity: "remote:ssh:box:22:me:/work/app" },
        { concurrency: 3 },
      ),
    ).toThrow(/远程工作区/);
  });
});
