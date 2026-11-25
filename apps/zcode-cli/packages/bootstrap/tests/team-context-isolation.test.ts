// 任务级上下文隔离：任务范围关闭后置 pending_fresh；
// 只有下一个新任务开始前才清空模型上下文，追问仍保留旧上下文。
// 记忆不在这里自动写：agent 通过 SaveMemory 写，TeamService 只负责在叫醒前读成背景资料。
// 这里用真实 TeamStore + 脚本化 runner 跑完整调度，不依赖真实模型。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS } from "@zcode/contracts";
import { TeamService, type TeamTurnRunner } from "../src/team/team-service.js";
import { TeamStore } from "../src/team/team-store.js";
import { appendSavedMemory, readMemberMemory } from "../src/team/team-memory.js";

const dirs: string[] = [];
const stores: TeamStore[] = [];

function newStore(): { store: TeamStore; memoryDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-context-"));
  dirs.push(dir);
  const store = new TeamStore({
    file: join(dir, "team.db"),
    limits: DEFAULT_TEAM_LIMITS,
    idPrefix: "t",
  });
  stores.push(store);
  return { store, memoryDir: join(dir, "memory") };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function findTask(store: TeamStore, memberId: string, title: string) {
  return store.tasks().find((task) => task.ownerId === memberId && task.title === title);
}

describe("task scope isolation", () => {
  it("崩溃恢复：认领快照里已关闭的任务置 pending_fresh，不补写记忆", () => {
    const { store, memoryDir } = newStore();
    const supervisor = store.createSupervisor({
      name: "主管",
      role: "supervisor",
      purpose: "接需求",
    });
    const member = store.createMember({
      bySessionId: supervisor.sessionId,
      name: "前端",
      role: "fe",
      purpose: "实现",
    });
    store.send({
      fromSessionId: supervisor.sessionId,
      to: member.id,
      kind: "task",
      content: "任务 A",
    });
    const task = findTask(store, member.id, "任务 A")!;
    const turn = store.claimTurn(member);
    expect(turn.openTasks.map((item) => item.id)).toEqual([task.id]);

    store.submit({
      fromSessionId: member.sessionId,
      taskId: task.id,
      result: "完成\n记忆要点：\n- 改了 a.ts",
      state: "done",
    });

    const recovered = store.recoverDanglingTurns();

    expect(recovered).toBe(1);
    expect(store.pendingFresh(member.id)).toBe(true);
    // 系统不再从提交正文里截取记忆；这条结果没有经过 SaveMemory。
    expect(readMemberMemory(memoryDir, member.id).text).toBe("");
  });

  it("任务 A 完成后追问保留上下文，任务 B 开始前 freshContext 才为 true", async () => {
    const { store, memoryDir } = newStore();
    // 记忆按成员 id 落盘，所以先建出成员，再拿它的 id 作为键。
    const supervisor = store.createSupervisor({
      name: "主管",
      role: "supervisor",
      purpose: "接需求",
    });
    const feMember = store.createMember({
      bySessionId: supervisor.sessionId,
      name: "前端",
      role: "fe",
      purpose: "实现",
      module: "src/**",
    });
    appendSavedMemory(memoryDir, feMember, {
      kind: "knowledge",
      content: "接口约定：a.ts 的 run() 返回 Promise。",
    });
    const fresh: boolean[] = [];
    const fePrompts: string[] = [];
    const backgrounds: Array<string | undefined> = [];
    let asked = false;

    const runner: TeamTurnRunner = {
      async run({ member, prompt, freshContext, backgroundContext }) {
        if (member.role === "supervisor") {
          const fe = store.memberByName("前端");
          if (!fe) {
            const created = store.createMember({
              bySessionId: member.sessionId,
              name: "前端",
              role: "fe",
              purpose: "实现",
              module: "src/**",
            });
            store.send({
              fromSessionId: member.sessionId,
              to: created.id,
              kind: "task",
              content: "任务 A",
            });
            return { ok: true };
          }

          const taskA = findTask(store, fe.id, "任务 A");
          const taskB = findTask(store, fe.id, "任务 B");
          if (taskA === undefined) {
            store.send({
              fromSessionId: member.sessionId,
              to: fe.id,
              kind: "task",
              content: "任务 A",
            });
          } else if (taskA.state === "open") {
            // 等前端提交 A。
          } else if (!asked) {
            asked = true;
            store.send({
              fromSessionId: member.sessionId,
              to: fe.id,
              kind: "question",
              content: "问一下进度",
            });
          } else if (taskB === undefined) {
            store.send({
              fromSessionId: member.sessionId,
              to: fe.id,
              kind: "task",
              content: "任务 B",
            });
          } else if (taskB.state !== "open") {
            store.deliver({ fromSessionId: member.sessionId, content: "交付完成" });
          }
          return { ok: true };
        }

        if (member.role === "fe") {
          fresh.push(freshContext === true);
          fePrompts.push(prompt);
          backgrounds.push(backgroundContext);
          const open = store
            .tasks()
            .find((task) => task.ownerId === member.id && task.state === "open");
          if (open !== undefined) {
            // 模拟 agent 在提交前调用 SaveMemory：只有这里会写记忆，键是成员 id。
            appendSavedMemory(memoryDir, member, {
              kind: "task",
              content: `完成了 ${open.title}`,
            });
            store.submit({
              fromSessionId: member.sessionId,
              taskId: open.id,
              result: `完成 ${open.title}\n\n记忆要点：\n- 这段正文不再被系统写入记忆`,
              state: "done",
            });
          } else if (prompt.includes("问一下进度")) {
            store.send({
              fromSessionId: member.sessionId,
              to: store.memberByRole("supervisor")!.id,
              kind: "answer",
              content: "进度正常",
            });
          }
          return { ok: true, ...(freshContext ? { contextReset: "applied" as const } : {}) };
        }

        return { ok: true };
      },
    };

    const service = new TeamService({
      store,
      runner,
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      concurrency: 2,
      pollMs: 5,
      stallTicks: 10,
      maxDurationMs: 20_000,
      memoryDir,
    });

    const result = await service.run({ requirement: "做两个任务" });

    expect(result.ok).toBe(true);
    // 任务 A（false）→ 追问（false，保留 A 的上下文）→ 任务 B（true，清空后开始）。
    expect(fresh).toEqual([false, false, true]);
    // 记忆不进入 query；它单独作为 backgroundContext 交给 runner。
    for (const prompt of fePrompts) {
      expect(prompt).not.toContain("你的长期记忆");
      expect(prompt).not.toContain("接口约定：a.ts");
      expect(prompt).not.toContain("记忆文件");
    }
    expect(backgrounds[0]).toContain("接口约定：a.ts");
    expect(backgrounds[1]).toContain("接口约定：a.ts");
    // 任务 A 提交时由脚本化 agent 自己保存，下一次叫醒（追问轮）就能看到。
    expect(backgrounds[1]).toContain("完成了 任务 A");
    // 系统没有从 SubmitTask 正文里截取“记忆要点”。
    const memory = readMemberMemory(memoryDir, feMember.id).text;
    expect(memory).toContain("接口约定：a.ts");
    expect(memory).toContain("完成了 任务 A");
    expect(memory).not.toContain("这段正文不再被系统写入记忆");
    expect(memory).not.toContain("任务「任务 A」完成");
  });
});
