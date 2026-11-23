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

    await runner.dispose();
  });
});
