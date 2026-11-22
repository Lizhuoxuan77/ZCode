// ============================================================
// Team Service — 调度器
// ============================================================
// 整个系统只有一个驱动者。它问两个问题，不问第三个：
//   1. 谁 idle？   2. 谁的收件箱非空？
// 一旦它开始判断「这个任务重不重要先跑」，它就变成第二个大脑，和主管抢决策权。
//
// 一轮的边界就是一次 executeTurn：装载 prompt → 跑完 → 交还。运行期没有跨轮状态，
// 因此进程重启、挂起唤醒、并发执行三件事同时成立。
//
// 超时与崩溃都不是异常分支，而是**消息**：watchdog 往邮箱里投一条，等待者下一轮读到。
// 这样正常路径和异常路径只有一条代码路径。

import { buildTeamTurnPrompt } from "@zcode/core";
import type { Logger, TeamMemberRef, TeamRole, TeamStartResult } from "@zcode/contracts";
import { appendMemberMemory, oneLine, readMemberMemory } from "./team-memory.js";
import { TeamStore, type ClaimedTurn } from "./team-store.js";

export interface TeamTurnRunner {
  /** 跑一轮。ok=false 时的 error 会作为系统消息回投给这个成员。 */
  run(input: {
    member: TeamMemberRef;
    prompt: string;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; error?: string }>;
}

export interface TeamServiceOptions {
  store: TeamStore;
  runner: TeamTurnRunner;
  supervisor: { name: string; role: TeamRole; purpose: string };
  concurrency?: number;
  /** 连续多少次「没人可跑也没人在跑」判定为停滞。 */
  stallTicks?: number;
  /** 整次交付的硬上限，防止一个坏掉的团队把进程占住。 */
  maxDurationMs?: number;
  /**
   * 单个成员一轮的上限。成员一轮里可能写很多文件，但**不允许无上限**：
   * 一个卡住的成员会吃掉整个交付预算，让其他成员一直排队（实测：组长一轮跑了 20 分钟，
   * 而整次交付只有 30 分钟）。到点 abort 这一轮，投一条超时消息，让它自己决定重试还是上报。
   */
  turnTimeoutMs?: number;
  pollMs?: number;
  logger?: Logger;
  /** 成员的记忆目录（`.zcode/team/memory`）。不给就不启用跨进程记忆。 */
  memoryDir?: string;
  /** 项目名，写进组建期的目标里，让主管知道自己是在给谁配人。 */
  projectName?: string;
  /** 组建期最多跑几轮主管回合（每轮之间会投一条「还差什么」的继续信号）。 */
  staffingRounds?: number;
}

export class TeamService {
  private readonly store: TeamStore;
  private readonly runner: TeamTurnRunner;
  private readonly concurrency: number;
  private readonly stallTicks: number;
  private readonly maxDurationMs: number;
  private readonly turnTimeoutMs: number;
  /** 正在跑的轮次，超时/取消时要能逐个中止。 */
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly pollMs: number;
  private busy = 0;

  constructor(private readonly options: TeamServiceOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.stallTicks = Math.max(2, options.stallTicks ?? 6);
    this.maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 15 * 60_000;
    this.pollMs = options.pollMs ?? 40;
  }

  /**
   * 发起一次交付并等它收敛。同一个团队上并发调用会排队——
   * 这不是性能问题，是语义问题：两次交付共用一个任务板，没人分得清哪条消息属于哪次。
   */
  async run(input: { requirement: string; signal?: AbortSignal }): Promise<TeamStartResult> {
    const supervisor = this.ensureSupervisor();
    const recovered = this.store.recoverDanglingTurns();
    if (recovered > 0) {
      this.options.logger?.warn?.("Team resumed after an unclean exit", {
        event: "team.recovered",
        module: "bootstrap.team",
        recovered,
      });
    }

    this.store.startRequirement(supervisor.id, input.requirement);

    const startedAt = Date.now();
    let idleTicks = 0;
    const running = new Set<Promise<void>>();

    while (true) {
      if (input.signal?.aborted === true) {
        return { ok: false, summary: "团队交付已被取消。" };
      }

      const delivered = this.store.delivery();
      if (delivered !== undefined) {
        return { ok: true, summary: delivered };
      }

      if (Date.now() - startedAt > this.maxDurationMs) {
        // 只 return 是不够的：在跑的 turn 会继续跑完，并在一个已经没有驱动的团队里派活，
        // 那些工作包就永远停在 open（实测发生过：组长在超时后 2 分钟派出 3 个工作包）。
        await this.abortRunningTurns(running);
        return {
          ok: false,
          summary:
            `团队在 ${Math.round(this.maxDurationMs / 60_000)} 分钟内没有收敛，已中止在跑的成员。\n` +
            `未完成的任务仍在任务板上，再次发起会接着干。\n${this.store.describeStall()}`,
        };
      }

      this.store.expireWaits();

      const slots = this.concurrency - running.size;
      const ready = slots > 0 ? this.store.readyMembers(slots) : [];
      for (const member of ready) {
        const task = this.runOne(member, input.signal).finally(() => {
          running.delete(task);
        });
        running.add(task);
      }

      const stalled = running.size === 0 && ready.length === 0 && !this.store.hasWaiting();
      idleTicks = stalled ? idleTicks + 1 : 0;
      if (idleTicks >= this.stallTicks) {
        await this.abortRunningTurns(running);
        return {
          ok: false,
          summary: `团队停滞：没有任何成员可跑，也没有人在等回复。\n${this.store.describeStall()}`,
        };
      }

      await delay(this.pollMs);
    }
  }

  /**
   * 组建期：把团队配齐，而不是做需求。
   *
   * 与 run() 的区别只有「什么时候算结束」：这里没有交付物可等，主管交出一份编制说明
   * （DeliverResult）才算完。中间每一轮之间投一条继续信号——否则主管一轮只招了一个人，
   * 调度器就会认为「没人可跑」= 停滞。
   */
  async staff(input: { signal?: AbortSignal } = {}): Promise<TeamStartResult> {
    const supervisor = this.ensureSupervisor();
    const recovered = this.store.recoverDanglingTurns();
    if (recovered > 0) {
      this.options.logger?.warn?.("Team resumed staffing after an unclean exit", {
        event: "team.recovered",
        module: "bootstrap.team",
        recovered,
      });
    }

    this.store.beginStaffing(supervisor.id, this.options.projectName ?? "这个项目");
    const startedAt = Date.now();
    const maxRounds = Math.max(2, this.options.staffingRounds ?? 8);

    for (let round = 0; round < maxRounds; round += 1) {
      if (input.signal?.aborted === true) {
        this.store.clearWaits();
        return { ok: false, summary: "组建团队已被取消。已招到的人会留在团队里。" };
      }

      const delivered = this.store.delivery();
      if (delivered !== undefined) return { ok: true, summary: delivered };

      if (Date.now() - startedAt > this.maxDurationMs) {
        return {
          ok: false,
          summary:
            `组建期超过 ${Math.round(this.maxDurationMs / 60_000)} 分钟仍未交出编制，已停下。\n` +
            `${this.store.describeStall()}`,
        };
      }

      await this.runOne(supervisor, input.signal, { staffing: true });

      const after = this.store.delivery();
      if (after !== undefined) return { ok: true, summary: after };

      // 还没交编制：把现状说清楚再让它继续，而不是空转。
      const roster = this.store.members();
      const missing = roster.filter(
        (member) => member.id !== supervisor.id && member.module.trim().length === 0,
      );
      this.store.systemMessage(
        supervisor.id,
        [
          `第 ${round + 1} 轮结束，编制还没交付。现在 ${roster.length} 人：` +
            roster.map((member) => `${member.name}${member.module ? `/${member.module}` : ""}`).join("、") +
            "。",
          missing.length > 0
            ? `这些成员没写负责模块：${missing.map((member) => member.name).join("、")}。补清楚，或换一个边界明确的。`
            : "",
          "检查两件事：关键模块都有负责人了吗？每个负责人的独占范围写清了吗？",
          "都满足就用 DeliverResult 报告编制；否则继续用 CreateTeammate 招人。不要开始写代码。",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }

    return {
      ok: false,
      summary:
        `组建期跑了 ${maxRounds} 轮仍未交出编制。当前状态：\n${this.store.describeStall()}\n` +
        "已招到的人会保留；再次发起组建会在此基础上继续。",
    };
  }

  private readMemory(memberName: string): string {
    const dir = this.options.memoryDir;
    return dir === undefined ? "" : readMemberMemory(dir, memberName);
  }

  /**
   * 把这一轮写进成员自己的记忆文件。系统侧自动维护——模型不需要记得写，
   * 而进程重启后它会从文件里读到「我上次干到哪」。
   */
  private recordMemory(
    turn: ClaimedTurn,
    outcome: { ok: boolean; error?: string },
  ): void {
    const dir = this.options.memoryDir;
    if (dir === undefined) return;
    const names = new Map(this.store.members().map((member) => [member.id, member.name]));
    const head = turn.messages
      .slice(0, 3)
      .map(
        (message) =>
          `${message.kind} 来自 ${names.get(message.from) ?? "?"}「${oneLine(message.content, 24)}」`,
      )
      .join("；");
    const more = turn.messages.length > 3 ? ` 等 ${turn.messages.length} 条` : "";
    const result = outcome.ok ? "ok" : `失败：${oneLine(outcome.error ?? "", 40)}`;
    appendMemberMemory(
      dir,
      turn.member.name,
      `${head.length > 0 ? head : "没有新消息"}${more} → ${result}`,
    );
  }

  private async runOne(
    member: TeamMemberRef,
    outerSignal?: AbortSignal,
    intent: { staffing?: boolean } = {},
  ): Promise<void> {
    const turn = this.store.claimTurn(member);
    // 只有**这一轮**新加的等待才算「我要等回复」。上一轮留下的未到期等待不能让他
    // 在已经干完活之后继续挂着——那会把一个空闲的人错标成 waiting，团队看起来停滞。
    const waitsBefore = this.store.waitCount(member.id);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    this.activeTurns.set(member.id, controller);
    let timedOut = false;
    const turnTimer = setTimeout(() => {
      timedOut = true;
      this.options.logger?.warn?.(`Team turn timed out: ${member.name}`, {
        event: "team.turn.timeout",
        module: "bootstrap.team",
        member: member.name,
        turnTimeoutMs: this.turnTimeoutMs,
      });
      controller.abort();
    }, this.turnTimeoutMs);

    try {
      const prompt = buildTeamTurnPrompt({
        member: turn.member,
        members: this.store.members(),
        inbox: turn.messages,
        tasks: this.store.tasks(),
        goal: this.store.getMeta("goal") ?? "",
        ...(intent.staffing === true ? { staffing: true } : {}),
        ...(() => {
          const memory = this.readMemory(member.name);
          return memory.length > 0 ? { memory } : {};
        })(),
      });
      this.options.logger?.info?.(`Team turn: ${member.name}`, {
        event: "team.turn.started",
        module: "bootstrap.team",
        member: member.name,
        messages: turn.messages.length,
      });
      const outcome = await this.runner.run({
        member: turn.member,
        prompt,
        signal: controller.signal,
      });
      this.recordMemory(turn, outcome);
      this.store.finishTurn({
        turnId: turn.turnId,
        memberId: member.id,
        awaitingReply: this.store.waitCount(member.id) > waitsBefore,
        ...(outcome.ok
          ? {}
          : {
              error: timedOut
                ? `本轮超过 ${Math.max(1, Math.round(this.turnTimeoutMs / 60_000))} 分钟被中止。先看已经产出/改动了什么，再决定继续、缩小范围或上报，不要从头再来一遍。`
                : (outcome.error ?? "unknown error"),
            }),
      });
    } catch (error) {
      // 兜底：runner 自己抛错（而不是返回 ok=false）时，团队不能因此永远停在 running。
      // 中止导致的抛错要和「执行失败」分开说：给模型的是「先看已经产出了什么」，
      // 不是「换一种做法重跑一遍」——后者会把已经写了一半的文件再写一遍。
      this.store.finishTurn({
        turnId: turn.turnId,
        memberId: member.id,
        awaitingReply: false,
        error: timedOut
          ? `本轮超过 ${Math.max(1, Math.round(this.turnTimeoutMs / 60_000))} 分钟被中止。先检查已产出/已改动的文件，再决定继续、缩小范围或上报，不要从头再来。`
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      clearTimeout(turnTimer);
      this.activeTurns.delete(member.id);
      outerSignal?.removeEventListener("abort", onAbort);
    }
  }

  /** 中止所有在跑的回合，并等它们把状态交还（finishTurn 会把成员放回 idle）。 */
  private async abortRunningTurns(running: Set<Promise<void>>): Promise<void> {
    for (const controller of this.activeTurns.values()) controller.abort();
    this.activeTurns.clear();
    await Promise.allSettled([...running]);
    // 等待租约在终止后没有意义：留着会让下一次发起误判为「还有人在等」。
    this.store.clearWaits();
  }

  private ensureSupervisor(): TeamMemberRef {
    const existing = this.store.memberByRole("supervisor");
    return existing ?? this.store.createSupervisor(this.options.supervisor);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
