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
import { formatMemoryContext, readMemberMemory } from "./team-memory.js";
import { TeamStore, type ClaimedTurn } from "./team-store.js";

export interface TeamTurnRunner {
  /** 跑一轮。ok=false 时的 error 会作为系统消息回投给这个成员。 */
  run(input: {
    member: TeamMemberRef;
    prompt: string;
    signal: AbortSignal;
    /**
     * 这一轮有任何可观测的输出时调用：模型开始请求、流式吐字、工具开跑/出结果。
     * 看门狗用它判断「多久没有输出」，而不是用墙钟判断「跑了多久」。
     */
    onActivity?: () => void;
    /**
     * 成员自己的长期记忆，作为背景资料交给 runtime；它不进 prompt，
     * 由 runner 作为 system-reminder 注入模型上下文。
     */
    backgroundContext?: string;
    /** 上一个任务范围已关闭，且这一轮有新任务：先清空模型上下文再跑。 */
    freshContext?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    /** freshContext 时运行时是否真的完成了上下文重置。 */
    contextReset?: "applied" | "skipped";
  }>;
}

export interface TeamServiceOptions {
  store: TeamStore;
  runner: TeamTurnRunner;
  supervisor: { name: string; role: TeamRole; purpose: string };
  concurrency?: number;
  /** 连续多少次「没人可跑也没人在跑」判定为停滞。 */
  stallTicks?: number;
  /**
   * 整次交付的硬上限，防止一个坏掉的团队把进程占住。**`0` 表示不限**：
   * 墙钟不是「失控」的判据，正常推进的团队跑几小时是健康的，卡死的团队由停滞检测发现。
   */
  maxDurationMs?: number;
  /**
   * 单个成员一轮的上限。成员一轮里可能写很多文件，但**不允许无上限**：
   * 一个卡住的成员会吃掉整次交付的时间，让其他成员一直排队。到点 abort 这一轮，
   * 投一条超时消息，让它自己决定重试还是上报。
   */
  turnTimeoutMs?: number;
  /**
   * 看门狗：一个成员连续多久**没有任何输出**就判定卡住，按超时处理（中止这一轮）。
   *
   * 这是「活性」判据，不是时长判据：一直在写文件、一直在跑工具的成员可以跑很久，
   * 一个 chunk 都没有才是真的卡住。`0` 表示关闭看门狗（只剩 turnTimeoutMs 兜底）。
   */
  stallTimeoutMs?: number;
  pollMs?: number;
  logger?: Logger;
  /**
   * 成员的记忆目录（用户数据目录里的 `teams/<slug>-<hash>/memory`）。
   * 调度器只在这里读取记忆、生成背景资料；写入由 agent 的 SaveMemory 工具负责。
   */
  memoryDir?: string;
  /** 项目名，写进组建期的目标里，让主管知道自己是在给谁配人。 */
  projectName?: string;
  /** 组建期最多跑几轮主管回合（每轮之间会投一条「还差什么」的继续信号）。 */
  staffingRounds?: number;
}

/** 一轮正在跑的执行体：能中止，并且记着它最后一次「有输出」是什么时候。 */
interface ActiveTurn {
  controller: AbortController;
  /** 最后一次观察到输出的时刻。看门狗用它算「静默了多久」。 */
  lastActivityAt: number;
  /** 被看门狗判定卡住的时刻；用来把结果说成「卡住」而不是「取消」。 */
  stalledAt?: number;
}

export class TeamService {
  private readonly store: TeamStore;
  private readonly runner: TeamTurnRunner;
  private readonly concurrency: number;
  private readonly stallTicks: number;
  private readonly maxDurationMs: number;
  private readonly turnTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  /** 正在跑的轮次，超时 / 取消 / 判卡住时要能逐个中止，并各自记着最后一次输出的时刻。 */
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pollMs: number;
  private busy = 0;

  constructor(private readonly options: TeamServiceOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.stallTicks = Math.max(2, options.stallTicks ?? 6);
    this.maxDurationMs = options.maxDurationMs ?? 2 * 60 * 60_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 10 * 60_000;
    this.pollMs = options.pollMs ?? 40;
  }

  /**
   * 发起一次交付并等它收敛。同一个团队上并发调用会排队——
   * 这不是性能问题，是语义问题：两次交付共用一个任务板，没人分得清哪条消息属于哪次。
   */
  async run(input: { requirement: string; signal?: AbortSignal }): Promise<TeamStartResult> {
    const supervisor = this.ensureSupervisor();
    // 崩溃恢复只负责把成员从 running 放回 idle、按认领快照补 pending_fresh；
    // 记忆由 agent 自己通过 SaveMemory 写，不再由调度器补摘要。
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
    /** memberId → 在跑的 turn；交付时要等主管那一轮把 finishTurn/任务摘要写完。 */
    const running = new Map<string, Promise<void>>();

    while (true) {
      if (input.signal?.aborted === true) {
        return { ok: false, summary: "团队交付已被取消。" };
      }

      const delivered = this.store.delivery();
      if (delivered !== undefined) {
        // deliver() 在主管 turn 内写 meta；如果直接返回，finishTurn 和
        // pending_fresh 可能还在跑。先等主管这一轮交还。
        const supervisorTurn = running.get(supervisor.id);
        if (supervisorTurn !== undefined) await supervisorTurn;
        return { ok: true, summary: delivered };
      }

      if (this.maxDurationMs > 0 && Date.now() - startedAt > this.maxDurationMs) {
        // 只 return 是不够的：在跑的 turn 会继续跑完，并在一个已经没有驱动的团队里派活，
        // 那些工作包就永远停在 open（实测发生过：组长在超时后 2 分钟派出 3 个工作包）。
        return this.drainAndStop(running, supervisor.id);
      }

      this.store.expireWaits(this.turnTimeoutMs);

      const slots = this.concurrency - running.size;
      const ready = slots > 0 ? this.store.readyMembers(slots) : [];
      for (const member of ready) {
        const task = this.runOne(member, input.signal).finally(() => {
          running.delete(member.id);
        });
        running.set(member.id, task);
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
    // 崩溃恢复只负责把成员从 running 放回 idle、按认领快照补 pending_fresh；
    // 记忆由 agent 自己通过 SaveMemory 写，不再由调度器补摘要。
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

      // 主管被看门狗判卡住：`staff()` 是顺序驱动的，不查状态就会拿它再跑一轮，
      // 结果只能是再卡一次。停在这里，把现状交给人看。
      if (this.store.memberById(supervisor.id)?.status === "failed") {
        return {
          ok: false,
          summary: `组建期主管被判定卡住，已停下。\n${this.store.describeStall()}`,
        };
      }

      if (this.maxDurationMs > 0 && Date.now() - startedAt > this.maxDurationMs) {
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

  /** 读成员自己的记忆并生成背景资料；没有记录时返回 undefined，不注入空条目。 */
  private readMemoryContext(memberName: string): string | undefined {
    const dir = this.options.memoryDir;
    if (dir === undefined) return undefined;
    const context = formatMemoryContext(readMemberMemory(dir, memberName));
    return context.length > 0 ? context : undefined;
  }

  /** 这一轮认领的任务范围是否整体结束；结束后下一次新任务要清空旧对话。 */
  private settleTurn(turn: ClaimedTurn): { scopeClosed: boolean } {
    return { scopeClosed: this.store.turnScope(turn).scopeClosed };
  }

  /**
   * 一轮的统一结算：按认领快照判断任务范围是否关闭，再交还成员状态。
   * 记忆不在这里写：agent 通过 SaveMemory 自己落盘，调度器只负责收尾状态。
   */
  private completeTurn(
    turn: ClaimedTurn,
    outcome: { ok: boolean; error?: string; stalled?: boolean },
    awaitingReply: boolean,
  ): void {
    const settlement = this.settleTurn(turn);
    if (settlement.scopeClosed) {
      this.store.setPendingFresh(turn.member.id, true);
    }
    this.store.finishTurn({
      turnId: turn.turnId,
      memberId: turn.member.id,
      awaitingReply,
      ...(outcome.ok
        ? {}
        : { stalled: outcome.stalled === true, error: outcome.error ?? "unknown error" }),
    });
  }

  private async runOne(
    member: TeamMemberRef,
    outerSignal?: AbortSignal,
    intent: { staffing?: boolean } = {},
  ): Promise<void> {
    const turn = this.store.claimTurn(member);
    // 上一个任务范围已关闭，且这一轮确实有新任务：让 runner 先清空模型上下文。
    // 只有追问/系统消息、没有新任务时不消费 pending_fresh，保留旧上下文。
    const freshContext = turn.pendingFresh && turn.openTasks.length > 0;
    // 只有**这一轮**新加的等待才算「我要等回复」。上一轮留下的未到期等待不能让他
    // 在已经干完活之后继续挂着——那会把一个空闲的人错标成 waiting，团队看起来停滞。
    const waitsBefore = this.store.waitCount(member.id);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    const active: ActiveTurn = { controller, lastActivityAt: Date.now() };
    this.activeTurns.set(member.id, active);
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
    const stallTimer =
      this.stallTimeoutMs > 0
        ? setInterval(() => this.watchStall(member.id, active), this.stallCheckIntervalMs())
        : undefined;

    try {
      // 记忆不进 prompt：它由 runner 作为背景上下文注入模型请求，
      // 用户 query 只保留这一轮要做的事。
      const backgroundContext = this.readMemoryContext(member.name);
      const prompt = buildTeamTurnPrompt({
        member: turn.member,
        members: this.store.members(),
        inbox: turn.messages,
        tasks: this.store.tasks(),
        goal: this.store.getMeta("goal") ?? "",
        ...(intent.staffing === true ? { staffing: true } : {}),
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
        onActivity: () => {
          active.lastActivityAt = Date.now();
        },
        ...(backgroundContext === undefined ? {} : { backgroundContext }),
        ...(freshContext ? { freshContext: true } : {}),
      });
      if (freshContext && outcome.contextReset === "applied") {
        this.store.setPendingFresh(member.id, false);
      }
      const stalled = active.stalledAt !== undefined;
      this.completeTurn(
        turn,
        {
          ok: outcome.ok,
          ...(outcome.ok
            ? {}
            : {
                stalled,
                error: stalled
                  ? `已有 ${Math.max(1, Math.round(this.stallTimeoutMs / 60_000))} 分钟没有任何输出，判定为卡住并中止了这一轮。`
                  : timedOut
                    ? `本轮超过 ${Math.max(1, Math.round(this.turnTimeoutMs / 60_000))} 分钟被中止。先看已经产出/改动了什么，再决定继续、缩小范围或上报，不要从头再来一遍。`
                    : (outcome.error ?? "unknown error"),
              }),
        },
        this.store.waitCount(member.id) > waitsBefore,
      );
    } catch (error) {
      // 兜底：runner 自己抛错（而不是返回 ok=false）时，团队不能因此永远停在 running。
      // 中止导致的抛错要和「执行失败」分开说：给模型的是「先看已经产出了什么」，
      // 不是「换一种做法重跑一遍」——后者会把已经写了一半的文件再写一遍。
      this.completeTurn(
        turn,
        {
          ok: false,
          stalled: active.stalledAt !== undefined,
          error:
            active.stalledAt !== undefined
              ? `已有 ${Math.max(1, Math.round(this.stallTimeoutMs / 60_000))} 分钟没有任何输出，判定为卡住并中止了这一轮。`
              : timedOut
                ? `本轮超过 ${Math.max(1, Math.round(this.turnTimeoutMs / 60_000))} 分钟被中止。先检查已产出/已改动的文件，再决定继续、缩小范围或上报，不要从头再来。`
                : error instanceof Error
                  ? error.message
                  : String(error),
        },
        false,
      );
    } finally {
      clearTimeout(turnTimer);
      if (stallTimer !== undefined) clearInterval(stallTimer);
      this.activeTurns.delete(member.id);
      outerSignal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 到了交付硬上限：不再派新活，给在跑的轮次一个收尾窗口。
   *
   * 原来的做法是立刻 abort 所有在跑的 turn。代价是每个正在工作的成员都会收到一条
   * 「失败 cancelled」，下一轮读到自己失败就从零重来——实测一次交付里两个成员各跑了
   * 近 900 秒，就这样被掐掉，任务板上留下三个 open 任务和三条未读的失败消息。
   * 软停让快跑完的那一轮正常交还，只有等满宽限期还没收尾的才被中止。
   */
  private async drainAndStop(
    running: Map<string, Promise<void>>,
    supervisorId: string,
  ): Promise<TeamStartResult> {
    this.options.logger?.warn?.("Team delivery reached max duration, draining", {
      event: "team.delivery.draining",
      module: "bootstrap.team",
      running: running.size,
      maxDurationMs: this.maxDurationMs,
    });
    // 宽限期取一个完整的单轮上限：在跑的 turn 本来也会在这么久之内被 turnTimeout 掐掉，
    // 所以总时长有硬上界，不会因为软停变成无限等待。
    const drainDeadline = Date.now() + this.turnTimeoutMs;
    while (running.size > 0 && Date.now() < drainDeadline) {
      const delivered = this.store.delivery();
      if (delivered !== undefined) {
        // 同 run() 的交付路径：deliver() 写在主管这一轮里，等它把 finishTurn
        // 与任务记忆收尾完，再返回，避免调用方在收尾前读到半截状态。
        const supervisorTurn = running.get(supervisorId);
        if (supervisorTurn !== undefined) await supervisorTurn;
        return { ok: true, summary: delivered };
      }
      this.store.expireWaits(this.turnTimeoutMs);
      await delay(this.pollMs);
    }
    const forced = running.size > 0;
    if (forced) await this.abortRunningTurns(running);
    return {
      ok: false,
      summary:
        `团队跑满 ${Math.round(this.maxDurationMs / 60_000)} 分钟，本次交付已暂停（不是失败）。\n` +
        (forced
          ? "有成员一轮没能在宽限期内收尾，已被中止。\n"
          : "在跑的成员都已正常收尾。\n") +
        "未完成的任务仍在任务板上，再次发起会接着干，不会从头再来。\n" +
        this.store.describeStall(),
    };
  }

  /**
   * 看门狗：这一轮很久没有任何输出就中止它。
   *
   * 判据是**活性**不是时长：一直在写文件、一直在跑工具的成员可以跑很久；一个 chunk 都没有
   * 才是卡住。卡住之后不自动重试——同一轮再跑一次只会再卡一次，成员会被置为 `failed`，
   * 由它的上级决定缩小范围、换做法还是换人（见 `TeamStore.finishTurn`）。
   *
   * 挂在每一轮自己身上，而不是靠调度主循环扫描：`staff()` 是 `await runOne` 阻塞式的，
   * 组建期主循环根本没在转，靠主循环的版本在那里一次也不会触发。
   */
  private watchStall(memberId: string, active: ActiveTurn): void {
    if (this.stallTimeoutMs <= 0) return;
    // 已经判过卡住的不再重复 abort：abort 是幂等的，但重复记日志只会刷屏。
    if (active.stalledAt !== undefined) return;
    const quietMs = Date.now() - active.lastActivityAt;
    if (quietMs < this.stallTimeoutMs) return;
    active.stalledAt = Date.now();
    this.options.logger?.warn?.(`Team turn stalled: ${memberId}`, {
      event: "team.turn.stalled",
      module: "bootstrap.team",
      member: memberId,
      quietMs,
      stallTimeoutMs: this.stallTimeoutMs,
    });
    active.controller.abort();
  }

  /** 看门狗的检查周期：比阈值密四倍，最少 50 毫秒，最多 5 秒（长阈值不需要高频扫）。 */
  private stallCheckIntervalMs(): number {
    return Math.min(5_000, Math.max(50, Math.floor(this.stallTimeoutMs / 4)));
  }

  /** 中止所有在跑的回合，并等它们把状态交还（finishTurn 会把成员放回 idle）。 */
  private async abortRunningTurns(running: Map<string, Promise<void>>): Promise<void> {
    for (const active of this.activeTurns.values()) active.controller.abort();
    this.activeTurns.clear();
    await Promise.allSettled(running.values());
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
