// SaveMemory 的落盘边界在 TeamPort：身份只来自调用会话，模型不能指定别人的名字。
// 这里用真实 TeamStore + 临时用户目录验证：成员能写自己的文件，非成员会被拒绝。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEAM_LIMITS,
  TeamFlowError,
  createRootTraceContext,
  createSessionId,
  createTurnId,
} from "@zcode/contracts";
import { resolveTeamStoragePaths } from "@zcode/shared/node";
import { afterEach, describe, expect, it } from "vitest";
import { readMemberMemory } from "../src/team/team-memory.js";
import { createTeamPort } from "../src/team/team-port.js";
import { TeamStore } from "../src/team/team-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
});

function setupPort() {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-team-port-memory-"));
  dirs.push(workspace);
  const storage = resolveTeamStoragePaths({
    cliStorageRoot: join(workspace, "cli"),
    workspacePath: workspace,
  });
  mkdirSync(storage.root, { recursive: true });
  writeFileSync(
    storage.configPath,
    JSON.stringify({
      name: "测试团队",
      supervisor: { name: "主管", purpose: "接需求" },
    }),
    "utf8",
  );

  const store = new TeamStore({
    file: storage.databasePath,
    limits: DEFAULT_TEAM_LIMITS,
    idPrefix: "t",
  });
  const supervisor = store.createSupervisor({
    name: "主管",
    role: "supervisor",
    purpose: "接需求",
  });
  const member = store.createMember({
    bySessionId: supervisor.sessionId,
    name: "组长",
    role: "lead",
    purpose: "实现",
    module: "src/**",
  });
  store.close();

  const traceContext = createRootTraceContext({
    sessionId: createSessionId("team-port-memory-parent"),
    turnId: createTurnId("team-port-memory-parent"),
  });
  const port = createTeamPort({
    workingDirectory: workspace,
    storage,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => {
        throw new Error("child logger is not used in this test");
      },
    },
    traceContext,
    getRuntimeDeps: () => ({}) as never,
  });
  return { port, storage, member };
}

describe("TeamPort.saveMemory", () => {
  it("按调用会话解析成员，把要点写进他自己的记忆文件", () => {
    const { port, storage, member } = setupPort();

    port.saveMemory({
      fromSessionId: member.sessionId,
      kind: "knowledge",
      content: "接口约定：a.ts 的 run() 返回 Promise。",
    });

    const snapshot = readMemberMemory(storage.memoryDir, member.id);
    expect(snapshot.file.endsWith(`${member.id}.md`)).toBe(true);
    expect(snapshot.text).toContain("## 模块知识");
    expect(snapshot.text).toContain("接口约定：a.ts 的 run() 返回 Promise。");
    // 名字只用于展示，不作为文件键。
    expect(readMemberMemory(storage.memoryDir, member.name).text).toBe("");
    expect(port.member(member.sessionId)?.name).toBe("组长");

    return port.dispose();
  });

  it("非团队成员不能保存记忆", () => {
    const { port } = setupPort();

    expect(() =>
      port.saveMemory({
        fromSessionId: createSessionId("not-a-team-member"),
        kind: "task",
        content: "越权写入",
      }),
    ).toThrow(TeamFlowError);

    return port.dispose();
  });
});
