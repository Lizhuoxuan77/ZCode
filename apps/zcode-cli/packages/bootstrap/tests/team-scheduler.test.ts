import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamService, type TeamTurnRunner } from "../src/team/team-service.js";
import { TeamStore } from "../src/team/team-store.js";

const dirs: string[] = [];
const stores: TeamStore[] = [];

function newStore(
  limits: { maxRevisions?: number } = {},
  now?: () => number,
): TeamStore {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-"));
  dirs.push(dir);
  const store = new TeamStore({
    file: join(dir, "team.db"),
    limits: { maxMembers: 6, maxDepth: 3, maxRevisions: 1, maxQuestionHops: 3, ...limits },
    idPrefix: "t",
    ...(now === undefined ? {} : { now }),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  // Windows 下 sqlite 句柄没关时删目录会 EPERM，而这个错误会把断言结果整个盖掉。
  // 先关库再删；删不掉也只是临时目录残留，不该让整条用例失败。
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
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
// 判据必须是「收到同事的结果」，不能用「提交」二字：提示词模板里
        // 「干完了用 SubmitTask 提交」每轮都在，用它会第一轮就判定交付，从没招过人。
        if (prompt.includes("【result】")) {
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

  it("选人按最早未读消息排序，不能按入职时间让协调者长期占位", () => {
    let clock = 1_000;
    const store = newStore({}, () => clock);

    const supervisor = store.createSupervisor({
      name: "主管",
      role: "supervisor",
      purpose: "接需求",
    });
    // 协调者入职最早；旧实现会让它们在两个并发名额里永远排第一。
    clock = 1_010;
    store.createMember({
      bySessionId: supervisor.sessionId,
      name: "产品经理",
      role: "pm",
      purpose: "出规划",
    });
    clock = 1_020;
    store.createMember({
      bySessionId: supervisor.sessionId,
      name: "界面设计",
      role: "ui",
      purpose: "出视觉",
    });
    clock = 1_030;
    store.createMember({
      bySessionId: supervisor.sessionId,
      name: "技术组长",
      role: "lead",
      purpose: "做外壳",
    });

    // 两个干活岗位的任务明显更早；产品经理后来又收到一条更新鲜的任务。
    clock = 1_100;
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "界面设计",
      kind: "task",
      content: "先做视觉规范",
    });
    clock = 1_110;
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "技术组长",
      kind: "task",
      content: "先搭应用外壳",
    });
    clock = 5_000;
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "产品经理",
      kind: "task",
      content: "补一份规划文档",
    });

    // 旧实现按入职时间会先选产品经理（1010）和界面设计（1020）；
    // 修复后按最早未读消息，界面设计（1100）和技术组长（1110）必须先被选中。
    expect(store.readyMembers(2).map((member) => member.name)).toEqual([
      "界面设计",
      "技术组长",
    ]);
  });

  it("maxDurationMs = 0 表示不限，不会因为「已运行 0 毫秒」立即超时", async () => {
    const store = newStore();
    const service = new TeamService({
      store,
      runner: scriptedRunner(store),
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
      maxDurationMs: 0,
    });

    const result = await service.run({ requirement: "给列表页加导出按钮" });

    expect(result.ok).toBe(true);
    expect(store.delivery()).toBeDefined();
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

  it("等待方不会因为对方这一轮还没跑完就被判超时", () => {
    const store = newStore();
    const supervisor = store.createSupervisor({ name: "主管", role: "supervisor", purpose: "接需求" });
    store.startRequirement(supervisor.id, "做点事");
    store.createMember({ bySessionId: supervisor.sessionId, name: "产品", role: "pm", purpose: "出规划" });
    const pm = store.memberByName("产品")!;

    const supervisorTurn = store.claimTurn(supervisor);
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "产品",
      kind: "task",
      content: "写 plan.md",
      awaitReply: true,
      // 租约立即到期，模拟「600 秒租约比 900 秒单轮上限短」的必然冲突。
      timeoutSec: -1,
    });
    store.finishTurn({ turnId: supervisorTurn.turnId, memberId: supervisor.id, awaitingReply: true });
    expect(store.memberById(supervisor.id)?.status).toBe("waiting");

    // 产品还在这一轮里干活：租约到期也不能算「没回复」。
    const pmTurn = store.claimTurn(pm);
    expect(store.expireWaits(15 * 60_000)).toBe(0);
    expect(store.memberById(supervisor.id)?.status).toBe("waiting");

    // 产品这一轮结束了却没回复：超时立即送达，不必再等原定 deadline。
    store.finishTurn({ turnId: pmTurn.turnId, memberId: pm.id, awaitingReply: false });
    expect(store.expireWaits(15 * 60_000)).toBe(1);
    expect(store.memberById(supervisor.id)?.status).toBe("idle");
    expect(store.readyMembers(5).map((member) => member.name)).toContain("主管");
  });

  it("清空租约时把 waiting 放回 idle，否则这些人永远不会再被调度", () => {
    const store = newStore();
    const supervisor = store.createSupervisor({ name: "主管", role: "supervisor", purpose: "接需求" });
    store.startRequirement(supervisor.id, "做点事");
    store.createMember({ bySessionId: supervisor.sessionId, name: "产品", role: "pm", purpose: "出规划" });

    const turn = store.claimTurn(supervisor);
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "产品",
      kind: "task",
      content: "写 plan.md",
      awaitReply: true,
    });
    store.finishTurn({ turnId: turn.turnId, memberId: supervisor.id, awaitingReply: true });
    expect(store.memberById(supervisor.id)?.status).toBe("waiting");

    store.clearWaits();

    expect(store.hasWaiting()).toBe(false);
    expect(store.memberById(supervisor.id)?.status).toBe("idle");
    // 下一次发起会往它邮箱投新任务；那时它必须能被选中（readyMembers 只选 idle）。
    store.startRequirement(supervisor.id, "第二票活");
    expect(store.readyMembers(5).map((member) => member.name)).toContain("主管");
  });

  it("对方结束时还有未读消息，不能把等待它的租约拨早成 0 秒假超时", () => {
    const store = newStore();
    const supervisor = store.createSupervisor({ name: "主管", role: "supervisor", purpose: "接需求" });
    store.startRequirement(supervisor.id, "做点事");
    store.createMember({ bySessionId: supervisor.sessionId, name: "产品", role: "pm", purpose: "出规划" });
    const pm = store.memberByName("产品")!;

    store.send({
      fromSessionId: supervisor.sessionId,
      to: "产品",
      kind: "task",
      content: "写 plan.md",
      awaitReply: true,
      timeoutSec: 600,
    });

    // 产品正在跑这一轮时，又收到一条消息（还没读到）。
    const pmTurn = store.claimTurn(pm);
    store.send({
      fromSessionId: supervisor.sessionId,
      to: "产品",
      kind: "question",
      content: "顺便确认一下配色",
    });

    // 这一轮结束时收件箱还有未读：它马上会被重新叫醒去处理，此刻不许判超时。
    store.finishTurn({ turnId: pmTurn.turnId, memberId: pm.id, awaitingReply: false });
    expect(store.expireWaits(15 * 60_000)).toBe(0);
    expect(store.readyMembers(5).map((member) => member.name)).toContain("产品");
  });

  it("看门狗：一轮长时间没有任何输出就判卡住，交给上级而不是自动重试", async () => {
    const store = newStore();
    const runner: TeamTurnRunner = {
      async run({ member, prompt, signal }) {
        if (member.role === "supervisor") {
          if (prompt.includes("[卡住]")) {
            store.deliver({
              fromSessionId: member.sessionId,
              content: "产品卡住了，我按已有产出先交付。",
            });
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
              content: "写 plan.md",
              awaitReply: true,
            });
          }
          return { ok: true };
        }
        // 产品：从不调用 onActivity，模拟卡在一个永不返回的请求上。
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return { ok: true };
      },
    };

    const service = new TeamService({
      store,
      runner,
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
      stallTimeoutMs: 60,
      turnTimeoutMs: 60_000,
      maxDurationMs: 0,
    });

    const result = await service.run({ requirement: "做点事" });

    expect(result.ok).toBe(true);
    // 卡住的人被置 failed：不会被 readyMembers 自动重排，要恢复必须由上级重新派活。
    expect(store.memberByName("产品")?.status).toBe("failed");
  });

  it("看门狗：一直在输出就不判卡住，哪怕总时长超过阈值", async () => {
    const store = newStore();
    const runner: TeamTurnRunner = {
      async run({ member, prompt, onActivity }) {
        if (member.role === "supervisor") {
          if (prompt.includes("【result】")) {
            store.deliver({ fromSessionId: member.sessionId, content: "交付：plan.md" });
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
              content: "写 plan.md",
              awaitReply: true,
            });
          }
          return { ok: true };
        }
        // 产品跑满 240 毫秒，远超 60 毫秒阈值，但每 30 毫秒都有输出。
        for (let step = 0; step < 8; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          onActivity?.();
        }
        store.submit({ fromSessionId: member.sessionId, result: "plan.md 已写", state: "done" });
        return { ok: true };
      },
    };

    const service = new TeamService({
      store,
      runner,
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
      stallTimeoutMs: 60,
      turnTimeoutMs: 60_000,
      maxDurationMs: 0,
    });

    const result = await service.run({ requirement: "做点事" });

    expect(result.ok).toBe(true);
    expect(store.memberByName("产品")?.status).toBe("idle");
  });

  it("组建期也受看门狗保护：主管一轮无输出会被中止并停下", async () => {
    const store = newStore();
    const runner: TeamTurnRunner = {
      async run({ signal }) {
        // 组建期主管：从不出声，模拟卡死。
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return { ok: true };
      },
    };

    const service = new TeamService({
      store,
      runner,
      supervisor: { name: "主管", role: "supervisor", purpose: "接需求" },
      pollMs: 5,
      stallTicks: 10,
      stallTimeoutMs: 60,
      turnTimeoutMs: 60_000,
      maxDurationMs: 0,
      staffingRounds: 3,
    });

    const result = await service.staff();

    expect(result.ok).toBe(false);
    expect(store.memberById(store.memberByName("主管")!.id)?.status).toBe("failed");
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
