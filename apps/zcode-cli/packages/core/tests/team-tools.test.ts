// 回归：SubmitTask 成功时曾把任务对象当成业务失败返回。
//
// 任务对象本身带 `result`（提交正文），工具层用 `"result" in output` 区分成功与失败，
// 于是成功提交被当成失败值送去 outputSchema 校验；校验失败后模型看到的是一段格式错误，
// 实际任务已经写入任务板。模型因此重复提交，再收到「该任务已经结束」。
// 这里从工具执行器入口跑一遍，确保失败转换、输出校验和模型可见回执同时被覆盖。

import {
  DEFAULT_TEAM_LIMITS,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type TeamMemberRef,
  type TeamPort,
  type TeamSaveMemoryRequest,
  type TeamSubmitRequest,
  type TeamTaskRef,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { teamSaveMemoryToolEntry, teamSubmitToolEntry } from "../src/tool/handlers/team.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

const SESSION_ID = createSessionId("team-tools-submit");
const TASK_ID = "tm_task_test";
const RESULT_TEXT = "改了 src/a.ts，并跑过 typecheck。";

function fakeMember(): TeamMemberRef {
  return {
    id: "tm_member_lead",
    name: "组长",
    role: "lead",
    parentId: "tm_member_supervisor",
    depth: 1,
    status: "running",
    sessionId: SESSION_ID,
    purpose: "实现功能",
    module: "src/**",
  };
}

function fakeTask(state: TeamTaskRef["state"]): TeamTaskRef {
  return {
    id: TASK_ID,
    ownerId: "tm_member_lead",
    title: "实现功能",
    state,
    revision: 0,
    createdAt: 1,
  };
}

function createTeamPort(state: TeamTaskRef["state"] = "open"): {
  port: TeamPort;
  submitted: TeamSubmitRequest[];
  saved: TeamSaveMemoryRequest[];
} {
  const submitted: TeamSubmitRequest[] = [];
  const saved: TeamSaveMemoryRequest[] = [];
  const member = fakeMember();
  const task = fakeTask(state);
  const port: TeamPort = {
    member: (sessionId) => (sessionId === SESSION_ID ? member : undefined),
    members: () => [member],
    tasks: () => [task],
    limits: () => DEFAULT_TEAM_LIMITS,
    createMember: () => {
      throw new Error("createMember is not used in this test");
    },
    send: () => {
      throw new Error("send is not used in this test");
    },
    submit: (request) => {
      submitted.push(request);
      return { ...task, state: "done", result: request.result };
    },
    saveMemory: (request) => {
      saved.push(request);
    },
    deliver: () => {
      throw new Error("deliver is not used in this test");
    },
  };
  return { port, submitted, saved };
}

function createExecutor(port: TeamPort) {
  const turnId = createTurnId("team-tools-submit");
  const traceContext = createRootTraceContext({ sessionId: SESSION_ID, turnId });
  const registry = createToolRegistry();
  registry.register(teamSubmitToolEntry);
  registry.register(teamSaveMemoryToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => undefined,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    teamPort: port,
    sessionId: SESSION_ID,
    turnId,
    traceContext,
  });
  return { executor, traceContext };
}

function modelText(result: ToolExecutionResult): string {
  const content = result.modelContent;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

describe("SubmitTask tool description", () => {
  it("要求提交前用 SaveMemory 记录要点，而不是把记忆塞进 result", () => {
    const description = teamSubmitToolEntry.metadata.description ?? "";
    expect(description).toContain("SaveMemory");
    expect(description).toContain("3-5 key points");
    expect(description).toContain("next task starts from it");
    expect(description).not.toContain("记忆要点");
  });
});

describe("SaveMemory handler output", () => {
  it("按调用会话解析身份，把 agent 自己总结的要点写进记忆", async () => {
    const { port, saved } = createTeamPort("open");
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-save-memory-kind"),
        input: { kind: "knowledge", content: "接口约定：src/a.ts 的 run() 返回 Promise。" },
        name: teamSaveMemoryToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(saved).toEqual([
      {
        fromSessionId: SESSION_ID,
        kind: "knowledge",
        content: "接口约定：src/a.ts 的 run() 返回 Promise。",
      },
    ]);
    expect(result.output).toMatchObject({ message: expect.stringContaining("已记住") });
    expect(modelText(result)).toContain("模块知识");
  });

  it("kind 缺省为 task，不需要模型每次重复", async () => {
    const { port, saved } = createTeamPort("open");
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-save-memory-default"),
        input: { content: "改了 a.ts；验证 typecheck 通过。" },
        name: teamSaveMemoryToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(saved[0]?.kind).toBe("task");
  });

  it("端口不支持记忆时返回业务失败，不谎称已保存", async () => {
    const { port } = createTeamPort("open");
    delete (port as { saveMemory?: unknown }).saveMemory;
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-save-memory-unsupported"),
        input: { content: "要点" },
        name: teamSaveMemoryToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(modelText(result)).toContain("不支持保存记忆");
  });

  it("空白内容不会被记成一条空记忆", async () => {
    const { port, saved } = createTeamPort("open");
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-save-memory-empty"),
        input: { content: "   " },
        name: teamSaveMemoryToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(saved).toHaveLength(0);
    expect(modelText(result)).toContain("记忆内容不能为空");
  });
});

describe("SubmitTask handler output", () => {
  it("成功提交时返回可读回执，而不是把任务对象当失败送去格式校验", async () => {
    const { port, submitted } = createTeamPort("open");
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-submit-ok"),
        input: { taskId: TASK_ID, result: RESULT_TEXT, state: "done" },
        name: teamSubmitToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      taskId: TASK_ID,
      result: RESULT_TEXT,
      state: "done",
    });
    expect(result.output).toMatchObject({
      message: expect.stringContaining("已提交"),
      taskId: TASK_ID,
      state: "done",
    });
    expect(modelText(result)).toContain("已提交");
    expect(modelText(result)).not.toContain("outputSchema");
  });

  it("已结束的任务仍返回业务失败，不会被成功回执掩盖", async () => {
    const { port, submitted } = createTeamPort("done");
    const { executor, traceContext } = createExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("team-submit-ended"),
        input: { taskId: TASK_ID, result: RESULT_TEXT, state: "done" },
        name: teamSubmitToolEntry.metadata.name,
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(submitted).toHaveLength(0);
    expect(modelText(result)).toContain("该任务已经结束，不能重复提交");
    expect(modelText(result)).not.toContain("outputSchema");
  });
});
