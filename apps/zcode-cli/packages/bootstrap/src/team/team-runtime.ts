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
import type { Logger, TeamMemberRef, TraceContext } from "@zcode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../app/script-workflow-child-runtime.js";
import { workflowActorToolPolicy } from "../app/workflow-actor-tools.js";
import type { TeamTurnRunner } from "./team-service.js";

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

  return {
    async prepare(member: TeamMemberRef) {
      await ensureRuntime(member);
    },

    async run({ member, prompt, signal }) {
      try {
        const runtime = await ensureRuntime(member);
        syncPersona(runtime, member);
        await runtime.executeTurn(prompt, undefined, { abortSignal: signal });
        // 一轮结束不等于成功：成员有没有产出，看它有没有调 SubmitTask / MessageTeammate。
        // 这些判断留在 store（任务板与邮箱），runner 只负责把这一轮跑完。
        return { ok: true };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: "cancelled" };
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async dispose() {
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
