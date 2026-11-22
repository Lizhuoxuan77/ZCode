// ============================================================
// Team Runtime — 把一轮团队工作落到真实 AgentRuntime
// ============================================================
// 每个成员一个**持久**子 runtime：第一次被叫醒时建，之后每轮都在同一个 runtime 上
// `executeTurn`。累计的是 messageHistory，不是内存状态——transcript 落在会话库里，
// 进程重启后由会话本身恢复。
//
// 这正是 dynamic-workflow 的 actor 用的那条路（createScriptWorkflowAgentRuntime）：
// 差别只在驱动者。workflow 由脚本决定叫谁跑，团队由邮箱决定。

import { roleBrief, type AgentRuntime } from "@zcode/core";
import type { Logger, TeamMemberRef, TraceContext } from "@zcode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../app/script-workflow-child-runtime.js";
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

  return {
    async prepare(member: TeamMemberRef) {
      await ensureRuntime(member);
    },

    async run({ member, prompt, signal }) {
      try {
        const runtime = await ensureRuntime(member);
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
        workflowActor: {
          name: member.name,
          persona: [
            roleBrief(member.role),
            `这个岗位在本团队里的职责：${member.purpose}`,
            member.module
              ? `你负责的模块：${member.module}。这个范围内的事由你决定；范围外要改，先找负责人商量。`
              : "",
            "你的会话是你的独立记忆：同事看不到你的上下文，你也看不到他们的。需要对齐就发消息。",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
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
    input.logger.info(`Team member session created: ${member.name}`, {
      event: "team.member.session_created",
      module: "bootstrap.team",
      member: member.name,
      sessionId: member.sessionId,
    });
    return runtime;
  }
}
