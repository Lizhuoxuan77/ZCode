import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamService, type TeamTurnRunner } from "../src/team/team-service.js";
import { TeamStore } from "../src/team/team-store.js";

const dirs: string[] = [];

function newStore(limits: { maxRevisions?: number } = {}): TeamStore {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-"));
  dirs.push(dir);
  return new TeamStore({
    file: join(dir, "team.db"),
    limits: { maxMembers: 6, maxDepth: 3, maxRevisions: 1, maxQuestionHops: 3, ...limits },
    idPrefix: "t",
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 只按「看到什么消息」做决定——和真模型的输入面完全一致。 */
function scriptedRunner(store: TeamStore): TeamTurnRunner {
  return {
    async run({ member, prompt }) {
      if (member.role === "supervisor") {
        if (prompt.includes("[超时]")) {
          store.deliver({ fromSessionId: member.sessionId, content: "超时后按默认方案交付。" });
          return { ok: true };
        }
        if (prompt.includes("提交")) {
          store.deliver({ fromSessionId: member.sessionId, content: "交付：规划 + 实现。" });
          return { ok: true };
        }
        if (!store.memberByName("产品")) {
          store.createMember({
            bySessionId: member.sessionId,
            name: "产品",
            role: "pm",
            purpose: "出规划",
          });
          store.send({
            fromSessionId: member.sessionId,
            to: "产品",
            kind: "task",
            content: "把这个需求拆成 plan.md",
            awaitReply: true,
            timeoutSec: 60,
          });
        }
        return { ok: true };
      }
      if (member.role === "pm") {
        store.submit({ fromSessionId: member.sessionId, result: "plan.md 已写", state: "done" });
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

describe("team scheduler", () => {
  it("一轮交付：主管招人 → 派活挂起 → 被回复唤醒 → 交付", async () => {
    const store = newStore();
    const service = new TeamService({
      store,
      runner: scriptedRunner(store),
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
    });

    const result = await service.run({ requirement: "给列表页加导出按钮" });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("交付");
    // 主管被唤醒两次：第一次派活，第二次读到提交结果。
    expect(store.delivery()).toBeDefined();
    // 任务板收敛：根任务与委派任务都结束。
    expect(store.tasks().every((task) => task.state !== "open")).toBe(true);
    // 人都还在（没有 done 状态）——干完只是回到 idle。
    expect(store.members().map((member) => member.status)).toEqual(["idle", "idle"]);
  });

  it("等待超时是一条消息，不是异常：等待者被叫醒后能自己决定", async () => {
    const store = newStore();
    const runner: TeamTurnRunner = {
      async run({ member, prompt }) {
        if (member.role === "supervisor") {
          if (prompt.includes("[超时]")) {
            store.deliver({ fromSessionId: member.sessionId, content: "等不到人，按默认值交付。" });
            return { ok: true };
          }
          if (!store.memberByName("前端")) {
            store.createMember({
              bySessionId: member.sessionId,
              name: "前端",
              role: "fe",
              purpose: "实现按钮",
            });
            store.send({
              fromSessionId: member.sessionId,
              to: "前端",
              kind: "task",
              content: "实现导出按钮",
              awaitReply: true,
              timeoutSec: 1,
            });
          }
        }
        return { ok: true };
      },
    };

    const service = new TeamService({
      store,
      runner,
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
      maxDurationMs: 8_000,
    });

    const result = await service.run({ requirement: "导出" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("默认值");
  });

  it("进程重启后，停在 running 的成员被重新放回可跑并收到一条说明", () => {
    const store = newStore();
    const supervisor = store.createSupervisor({ name: "主管", role: "supervisor", purpose: "接需求" });
    store.startRequirement(supervisor.id, "做点事");
    store.claimTurn(supervisor);

    expect(store.members()[0]?.status).toBe("running");
    const recovered = store.recoverDanglingTurns();

    expect(recovered).toBe(1);
    expect(store.members()[0]?.status).toBe("idle");
    // 恢复通知本身让这个成员重新可跑。
    expect(store.readyMembers(5).map((member) => member.name)).toContain("主管");
  });

  it("退回把任务重新打开并累计 revision，到顶后拒绝再退", () => {
    const store = newStore({ maxRevisions: 1 });
    const supervisor = store.createSupervisor({ name: "主管", role: "supervisor", purpose: "接需求" });
    store.createMember({
      bySessionId: supervisor.sessionId,
      name: "组长",
      role: "lead",
      purpose: "实施",
    });
    const lead = store.memberByName("组长")!;
    store.createMember({ bySessionId: lead.sessionId, name: "后端", role: "be", purpose: "实现" });
    const be = store.memberByName("后端")!;

    store.send({
      fromSessionId: lead.sessionId,
      to: "后端",
      kind: "task",
      content: "实现 toCsv",
    });
    store.submit({ fromSessionId: be.sessionId, result: "src/csv.ts", state: "done" });

    store.send({
      fromSessionId: lead.sessionId,
      to: "后端",
      kind: "reject",
      content: "缺 UTF-8 BOM，退回",
    });
    const reopened = store.tasks().find((task) => task.ownerId === be.id)!;
    expect(reopened.state).toBe("open");
    expect(reopened.revision).toBe(1);

    store.submit({ fromSessionId: be.sessionId, result: "已修", state: "done" });
    expect(() =>
      store.send({
        fromSessionId: lead.sessionId,
        to: "后端",
        kind: "reject",
        content: "还是不行",
      }),
    ).toThrow(/上限/);
  });
});
