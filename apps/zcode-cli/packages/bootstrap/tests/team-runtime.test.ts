// 成员模块/职责在创建后仍可能被 updateMember 修改。运行时必须在下一轮开始前重算 persona，
// 只刷新 system prompt，不能重建 runtime（重建会丢进程内 messageHistory）。
// 这里用假 runtime 验证接线：创建时写 team 契约与模块，模块变更后调用 updateWorkflowActor。

import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type TeamMemberRef,
} from "@zcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn() }));

vi.mock("../src/app/script-workflow-child-runtime.js", () => ({
  createScriptWorkflowAgentRuntime: mocks.createRuntime,
}));

import { createAgentRuntimeTeamRunner } from "../src/team/team-runtime.js";

const MEMBER: TeamMemberRef = {
  id: "tm_member_lead",
  name: "组长-办公插件",
  role: "lead",
  parentId: "tm_member_supervisor",
  depth: 1,
  status: "idle",
  sessionId: createSessionId("team-runtime-lead"),
  purpose: "负责办公插件模块",
  module: "src/renderer/src/dock-plugins/**",
};

function fakeRuntime() {
  return {
    ensureSessionPersistedForExternalActivity: vi.fn(async () => undefined),
    executeTurn: vi.fn(async () => undefined),
    updateWorkflowActor: vi.fn(),
    resetConversationToContextPrefix: vi.fn(() => ({ ok: true as const })),
    setTeamMemoryContext: vi.fn(() => ({ ok: true as const })),
    // 看门狗依赖会话事件订阅当活性心跳：fake 必须提供，否则 ensureRuntime 直接抛错。
    subscribeEvents: vi.fn(() => () => undefined),
    closeBrowserSession: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const traceContext = createRootTraceContext({
  sessionId: createSessionId("team-runtime-parent"),
  turnId: createTurnId("team-runtime-parent"),
});

function createRunner() {
  return createAgentRuntimeTeamRunner({
    deps: {} as never,
    logger: logger as never,
    traceContext,
  });
}

describe("team member runtime persona", () => {
  beforeEach(() => {
    mocks.createRuntime.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  it("创建时写团队契约与模块，模块变更后只刷新 system prompt", async () => {
    const runtime = fakeRuntime();
    mocks.createRuntime.mockReturnValue(runtime);
    const runner = createRunner();

    await runner.prepare(MEMBER);

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    const config = mocks.createRuntime.mock.calls[0]?.[0] as {
      configOverrides: {
        workflowActor: { name: string; persona: string; kind: string };
        toolDisallowlist: readonly string[];
      };
    };
    expect(config.configOverrides.workflowActor).toMatchObject({
      name: "组长-办公插件",
      kind: "team",
    });
    expect(config.configOverrides.workflowActor.persona).toContain(
      "src/renderer/src/dock-plugins/**",
    );
    // 团队会话拿不到问用户/计划模式等交互工具。
    expect(config.configOverrides.toolDisallowlist).toContain("AskUserQuestion");

    const updated: TeamMemberRef = { ...MEMBER, module: "src/renderer/src/new-scope/**" };
    await runner.run({
      member: updated,
      prompt: "继续",
      signal: new AbortController().signal,
    });

    expect(runtime.updateWorkflowActor).toHaveBeenCalledTimes(1);
    expect(runtime.updateWorkflowActor.mock.calls[0]?.[0]).toMatchObject({
      name: "组长-办公插件",
      kind: "team",
    });
    expect(runtime.updateWorkflowActor.mock.calls[0]?.[0].persona).toContain(
      "src/renderer/src/new-scope/**",
    );
    // 只刷新身份段，不重建 runtime。
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);

    await runner.run({
      member: updated,
      prompt: "继续",
      signal: new AbortController().signal,
    });
    expect(runtime.updateWorkflowActor).toHaveBeenCalledTimes(1);
    // 没有 freshContext 的普通轮次不得清上下文。
    expect(runtime.resetConversationToContextPrefix).not.toHaveBeenCalled();

    await runner.dispose();
  });

  it("新任务 starting fresh 时清空模型上下文，不重建 runtime", async () => {
    const runtime = fakeRuntime();
    mocks.createRuntime.mockReturnValue(runtime);
    const runner = createRunner();

    await runner.prepare(MEMBER);
    const outcome = await runner.run({
      member: MEMBER,
      prompt: "新任务",
      signal: new AbortController().signal,
      freshContext: true,
    });

    expect(outcome).toMatchObject({ ok: true, contextReset: "applied" });
    expect(runtime.resetConversationToContextPrefix).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);

    await runner.dispose();
  });

  it("把记忆作为背景上下文注入模型请求，且排在 executeTurn 之前", async () => {
    const runtime = fakeRuntime();
    mocks.createRuntime.mockReturnValue(runtime);
    const runner = createRunner();
    const order: string[] = [];
    runtime.setTeamMemoryContext.mockImplementation(() => {
      order.push("memory");
      return { ok: true as const };
    });
    runtime.executeTurn.mockImplementation(async () => {
      order.push("turn");
    });

    await runner.prepare(MEMBER);
    await runner.run({
      member: MEMBER,
      prompt: "任务",
      signal: new AbortController().signal,
      backgroundContext: "你的长期记忆：改了 a.ts",
    });

    expect(runtime.setTeamMemoryContext).toHaveBeenCalledWith({
      text: "你的长期记忆：改了 a.ts",
    });
    expect(order).toEqual(["memory", "turn"]);

    await runner.dispose();
  });

  it("重置被 busy 拒绝时返回 skipped，交给调度器保留待清空标志", async () => {
    const runtime = fakeRuntime();
    runtime.resetConversationToContextPrefix.mockReturnValue({
      ok: false as const,
      reason: "busy" as const,
    });
    mocks.createRuntime.mockReturnValue(runtime);
    const runner = createRunner();

    await runner.prepare(MEMBER);
    const outcome = await runner.run({
      member: MEMBER,
      prompt: "新任务",
      signal: new AbortController().signal,
      freshContext: true,
      backgroundContext: "旧任务记忆",
    });

    expect(outcome).toMatchObject({ ok: true, contextReset: "skipped" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("context reset skipped"),
      expect.objectContaining({ reason: "busy" }),
    );
    // 清空没做成时不改历史，保留旧记忆条目，下一次叫醒再刷新。
    expect(runtime.setTeamMemoryContext).not.toHaveBeenCalled();

    await runner.dispose();
  });
});
