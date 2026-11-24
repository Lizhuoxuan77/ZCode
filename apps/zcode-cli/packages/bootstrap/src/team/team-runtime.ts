// ============================================================
// Team Runtime — 把一轮团队工作落到真实 AgentRuntime
// ============================================================
// 每个成员一个**持久**子 runtime：第一次被叫醒时建，之后每轮都在同一个 runtime 上
// `executeTurn`。累计的是 messageHistory，不是内存状态——transcript 落在会话库里，
// 进程重启后由会话本身恢复。
//
// 这正是 dynamic-workflow 的 actor 用的那条路（createScriptWorkflowAgentRuntime）：
// 差别只在驱动者。workflow 由脚本决定叫谁跑，团队由邮箱决定。

import { buildMemberPersona, type AgentRuntime } from "@zcode/core";
import {
  SessionEventType,
  type Logger,
  type TeamMemberRef,
  type TraceContext,
} from "@zcode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../app/script-workflow-child-runtime.js";
import { workflowActorToolPolicy } from "../app/workflow-actor-tools.js";
import type { TeamTurnRunner } from "./team-service.js";

/**
 * 这些事件说明这一轮**真的在推进**：模型开始请求、流式吐字、工具开跑/出结果、压缩在动。
 *
 * 看门狗据此判断「多久没有输出」，而不是用墙钟判「跑了多久」——同一个 10 分钟，
 * 一直在写文件是健康的，一个 chunk 都没有才是卡住。白名单宁可宽：漏加一类的症状是
 * 把正常的长任务误判成卡住，那比放过一次真卡住更糟。
 */
const TURN_ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  SessionEventType.ModelRequest,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.AssistantMessage,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.ToolBatchComplete,
  SessionEventType.StreamRecoveryStarted,
  SessionEventType.StreamRecoveryRetryStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.HookRunProgress,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
]);

export interface AgentRuntimeTeamRunner extends TeamTurnRunner {
  /**
   * 招进来就把会话落库（不跑任何一轮）。成员在第一次被叫醒前也必须有可打开的页面，
   * 否则面板点它 = "Session not found"——组建期主管一口气招四五个人，个个都点不开。
   */
  prepare(member: TeamMemberRef): Promise<void>;
  /** 关掉所有成员会话（含浏览器 tab）。进程退出时调用。 */
  dispose(): Promise<void>;
}

export function createAgentRuntimeTeamRunner(input: {
  deps: ScriptWorkflowAgentRuntimeDeps;
  logger: Logger;
  traceContext: TraceContext;
}): AgentRuntimeTeamRunner {
  const runtimes = new Map<string, AgentRuntime>();
  /** 创建 runtime 时写进 system prompt 的 persona 快照；模块/职责改了要对比它。 */
  const personas = new Map<string, string>();
  /**
   * 当前这一轮的活动回调。事件订阅是 runtime 级的（跨轮复用），而「谁在听」是 turn 级的，
   * 所以这里只挂一个可变引用：本轮结束后清空，避免把心跳记到一个已经交还的轮次上。
   */
  const activityHooks = new Map<string, (() => void) | undefined>();
  const unsubscribers = new Map<string, () => void>();

  return {
    async prepare(member: TeamMemberRef) {
      await ensureRuntime(member);
    },

    async run({ member, prompt, signal, freshContext, backgroundContext, onActivity }) {
      activityHooks.set(member.id, onActivity);
      let contextReset: "applied" | "skipped" | undefined;
      try {
        const runtime = await ensureRuntime(member);
        syncPersona(runtime, member);
        if (freshContext === true) {
          // 上一个任务范围已关闭，且这一轮有新任务：丢掉旧任务的 provider 上下文。
          // 只清 messageHistory，session transcript 仍保留给界面审计。
          const reset = runtime.resetConversationToContextPrefix();
          contextReset = reset.ok ? "applied" : "skipped";
          if (!reset.ok) {
            input.logger.warn(`Team context reset skipped: ${member.name}`, {
              event: "team.turn.context_reset_skipped",
              module: "bootstrap.team",
              member: member.name,
              reason: reset.reason,
            });
          }
        }
        // 记忆是背景资料，不是用户的 query：作为 team_memory 的 system-reminder 注入。
        // 重置被 busy 拒绝时不改历史，保留旧条目，等下一轮再刷新。
        if (
          backgroundContext !== undefined &&
          backgroundContext.trim().length > 0 &&
          (freshContext !== true || contextReset === "applied")
        ) {
          const injected = runtime.setTeamMemoryContext({ text: backgroundContext });
          if (!injected.ok) {
            input.logger.warn(`Team memory context skipped: ${member.name}`, {
              event: "team.turn.memory_skipped",
              module: "bootstrap.team",
              member: member.name,
              reason: injected.reason,
            });
          } else {
            input.logger.debug(`Team memory context injected: ${member.name}`, {
              event: "team.turn.memory_injected",
              module: "bootstrap.team",
              member: member.name,
              chars: backgroundContext.length,
            });
          }
        }
        await runtime.executeTurn(prompt, undefined, { abortSignal: signal });
        // 一轮结束不等于成功：成员有没有产出，看它有没有调 SubmitTask / MessageTeammate。
        // 这些判断留在 store（任务板与邮箱），runner 只负责把这一轮跑完。
        return { ok: true, ...(contextReset === undefined ? {} : { contextReset }) };
      } catch (error) {
        if (signal.aborted) {
          return {
            ok: false,
            error: "cancelled",
            ...(contextReset === undefined ? {} : { contextReset }),
          };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(contextReset === undefined ? {} : { contextReset }),
        };
      } finally {
        activityHooks.set(member.id, undefined);
      }
    },

    async dispose() {
      for (const unsubscribe of unsubscribers.values()) unsubscribe();
      unsubscribers.clear();
      activityHooks.clear();
      const all = [...runtimes.values()];
      runtimes.clear();
      personas.clear();
      await Promise.allSettled(
        all.map(async (runtime) => {
          await runtime.closeBrowserSession().catch(() => undefined);
          await runtime.close().catch(() => undefined);
        }),
      );
    },
  };

  async function ensureRuntime(member: TeamMemberRef): Promise<AgentRuntime> {
    const existing = runtimes.get(member.id);
    if (existing) return existing;

    const persona = buildMemberPersona(member);
    const runtime = createScriptWorkflowAgentRuntime({
      childSessionId: member.sessionId,
      deps: input.deps,
      // request 在这里只是工厂签名的占位：persona 走 configOverrides.workflowActor 叠加，
      // 不是整段替换 system prompt。
      request: {
        prompt: "",
        opts: { agentType: `zcode-team-${member.role}`, label: member.name },
      },
      traceContext: input.traceContext,
      configOverrides: {
        // 团队成员的 system prompt 用团队专用契约：工作来自同事消息，工具是
        // CreateTeammate / MessageTeammate / SubmitTask / DeliverResult；
        // 没有 submit_result / escalate，也没有问用户的工具。
        workflowActor: { name: member.name, persona, kind: "team" },
        // 去掉主会话专用的交互工具（问用户、计划模式、嵌套工作流）。
        // 团队会话跑在 yolo 里，这些弹窗没有人应答；复用 workflow actor 的减法表，
        // 避免团队再维护一份“不该注册的工具”清单。
        ...workflowActorToolPolicy(),
        // 团队成员不继承父会话的 Plan/Guarded 模式：
        // 整次交付发生在一个工具调用内部，每次权限弹窗都会把主回合挂在那里等人。
        // 边界的表达方式是团队配置（可写目录 / 可跑命令），不是逐个成员的弹窗。
        mode: "yolo",
        // 成员不能再起子代理：招人必须经过 CreateTeammate，否则组织关系与预算都会失控。
        subagents: { enabled: false },
      },
      interactionDescription: `${member.name}（${member.role}）`,
    });

    // 必须先把会话落库：transcript 的归属靠这条会话，冷恢复也靠它。
    await runtime.ensureSessionPersistedForExternalActivity(`团队 · ${member.name}`);
    // 订阅会话事件当「活性心跳」：看门狗据此判断这一轮多久没有输出，而不是用墙钟判跑了多久。
    // 订阅是 runtime 级的，跨轮复用；每轮由 activityHooks 决定这颗心跳记给谁。
    unsubscribers.set(
      member.id,
      runtime.subscribeEvents({
        onSessionEvent: (event) => {
          if (event.sessionId !== member.sessionId) return;
          if (!TURN_ACTIVITY_EVENTS.has(event.type)) return;
          activityHooks.get(member.id)?.();
        },
      }),
    );
    runtimes.set(member.id, runtime);
    personas.set(member.id, persona);
    input.logger.info(`Team member session created: ${member.name}`, {
      event: "team.member.session_created",
      module: "bootstrap.team",
      member: member.name,
      sessionId: member.sessionId,
    });
    return runtime;
  }

  /**
   * 模块/职责改了，人设跟着变。只换 system prompt 的身份段，不重建 runtime：
   * 重建会丢掉进程内的 messageHistory；会话 transcript 虽然落库，但同一进程里的
   * 新 runtime 不会自动把历史接回来。下一轮开始前调用，此时没有在跑的 turn。
   */
  function syncPersona(runtime: AgentRuntime, member: TeamMemberRef): void {
    const persona = buildMemberPersona(member);
    if (personas.get(member.id) === persona) return;
    runtime.updateWorkflowActor({ name: member.name, persona, kind: "team" });
    personas.set(member.id, persona);
    input.logger.info(`Team member persona refreshed: ${member.name}`, {
      event: "team.member.persona_refreshed",
      module: "bootstrap.team",
      member: member.name,
      sessionId: member.sessionId,
    });
  }
}
