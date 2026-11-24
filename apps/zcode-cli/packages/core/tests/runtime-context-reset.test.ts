// 任务级上下文隔离的运行时原语：回到 context prefix，丢掉当前对话，但保留
// session transcript 与消息 id。重置只能在两轮之间发生；有在跑的 turn/后台任务/排队输入时拒绝。

import { describe, expect, it, vi } from "vitest";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resetConversationToContextPrefix } from "../src/runtime/methods/context-reset.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

const rebuild = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime/methods/context-refresh.js", () => ({
  rebuildContextPrefix: rebuild,
}));

function createRuntime(overrides: Record<string, unknown> = {}) {
  const messageHistory = {
    reset: vi.fn(),
    setCacheMiss: vi.fn(),
    borrowReadOnlyRuntimeEntries: vi.fn(() => []),
  };
  const readFileState: ReadFileStateMap = new Map();
  readFileState.set("/workspace/MEMORY.md", {
    path: "/workspace/MEMORY.md",
    content: "memory index",
    isPartialView: false,
    readAt: new Date(0),
    seededFromContext: true,
  });
  readFileState.set("/workspace/src/a.ts", {
    path: "/workspace/src/a.ts",
    content: "task file",
    isPartialView: false,
    readAt: new Date(0),
  });
  const runtime = {
    messageHistory,
    readFileState,
    contextBuilder: {},
    contextInitialized: true,
    memoryRecallState: {},
    memoryRecallPrefetch: undefined,
    pendingMemoryUpdate: {},
    totalTokensBudget: { rolledOver: 1, anchor: 2, maxUsed: 3 },
    autoCompactConsecutiveFailures: 2,
    currentTurnFileChanges: new Map([["a", {}]]),
    lastAssistantCompletedAtMs: 123,
    pendingInputReservations: new Map(),
    pendingInputEditLocks: new Map(),
    activeTurnStartReservation: undefined,
    hasActiveOrQueuedTurnWork: () => false,
    hasRunningBackgroundTasks: () => false,
    hasResidencyBlockingWork: () => false,
    ...overrides,
  } as unknown as AgentRuntimeInternal;
  return { runtime, messageHistory, readFileState };
}

describe("MessageHistory.reset", () => {
  it("只保留 leading context prefix，丢掉上一段对话", () => {
    const history = new MessageHistoryImpl();
    history.init("system prompt");
    history.addUser("旧任务");
    history.addAssistant("旧回答");

    history.reset();

    expect(history.borrowReadOnlyRuntimeEntries().map((entry) => entry.message.role)).toEqual([
      "system",
    ]);

    history.addUser("新任务");
    expect(history.borrowReadOnlyRuntimeEntries().map((entry) => entry.message.role)).toEqual([
      "system",
      "user",
    ]);
  });
});

describe("resetConversationToContextPrefix", () => {
  it("清掉对话但保留 context prefix、seeded read state 和 session 身份", () => {
    const { runtime, messageHistory, readFileState } = createRuntime();

    const result = resetConversationToContextPrefix.call(runtime);

    expect(result).toEqual({ ok: true });
    expect(messageHistory.reset).toHaveBeenCalledTimes(1);
    expect(messageHistory.setCacheMiss).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    // 任务期间读过的文件要重新 Read；MEMORY.md 索引的读写守卫保留。
    expect([...readFileState.values()].map((entry) => entry.path)).toEqual([
      "/workspace/MEMORY.md",
    ]);
    expect(runtime.totalTokensBudget).toEqual({ rolledOver: 0, anchor: 0, maxUsed: 0 });
    expect(runtime.autoCompactConsecutiveFailures).toBe(0);
    expect(runtime.currentTurnFileChanges.size).toBe(0);
    expect(runtime.lastAssistantCompletedAtMs).toBeUndefined();
    expect(runtime.pendingMemoryUpdate).toBeUndefined();
  });

  it("有在跑的 turn 或后台任务时拒绝，不碰历史", () => {
    const { runtime, messageHistory, readFileState } = createRuntime({
      hasRunningBackgroundTasks: () => true,
    });

    expect(resetConversationToContextPrefix.call(runtime)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(messageHistory.reset).not.toHaveBeenCalled();
    expect(readFileState.size).toBe(2);
  });

  it("有排队输入锁时拒绝", () => {
    const { runtime, messageHistory } = createRuntime({
      pendingInputEditLocks: new Map([["input-1", {}]]),
    });

    expect(resetConversationToContextPrefix.call(runtime)).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(messageHistory.reset).not.toHaveBeenCalled();
  });
});
