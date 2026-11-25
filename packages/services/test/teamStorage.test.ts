import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { writeTeamConfig } from "../src/zcode-agent/teamConfigWrite.js";
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
});
