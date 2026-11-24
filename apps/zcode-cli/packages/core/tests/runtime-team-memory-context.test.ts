// 团队成员的长期记忆是背景资料，不是用户 query。
// 这里验证运行时原语：首次叫醒追加、同源内容原地替换、文本未变不动作、
// 有活动 turn 时拒绝、reset 之后随对话一起清掉。

import { describe, expect, it, vi } from "vitest";
import {
  isRuntimeAttachmentEntry,
  MessageHistoryImpl,
} from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { setTeamMemoryContext } from "../src/runtime/methods/team-memory-context.js";

function createRuntime(activeTurn?: unknown) {
  const messageHistory = new MessageHistoryImpl();
  messageHistory.init("system prompt");
  const runtime = { messageHistory, activeTurn } as unknown as AgentRuntimeInternal;
  return { runtime, messageHistory };
}

function memoryEntries(history: MessageHistoryImpl) {
  return history
    .borrowReadOnlyRuntimeEntries()
    .filter(
      (entry) => isRuntimeAttachmentEntry(entry) && entry.metadata?.source === "team_memory",
    );
}

describe("setTeamMemoryContext", () => {
  it("第一次注入时追加一个 team_memory 背景条目", () => {
    const { runtime, messageHistory } = createRuntime();

    const result = setTeamMemoryContext.call(runtime, { text: "任务 A：改了 a.ts" });

    expect(result).toEqual({ ok: true });
    const entries = memoryEntries(messageHistory);
    expect(entries).toHaveLength(1);
    expect(isRuntimeAttachmentEntry(entries[0])).toBe(true);
    if (isRuntimeAttachmentEntry(entries[0])) {
      expect(entries[0].content).toBe("任务 A：改了 a.ts");
    }
  });

  it("内容变化时原地替换，不堆积第二份记忆", () => {
    const { runtime, messageHistory } = createRuntime();
    setTeamMemoryContext.call(runtime, { text: "旧记忆" });
    const before = messageHistory.borrowReadOnlyRuntimeEntries();
    const oldIndex = before.findIndex(
      (entry) => isRuntimeAttachmentEntry(entry) && entry.metadata?.source === "team_memory",
    );

    setTeamMemoryContext.call(runtime, { text: "新记忆" });

    const after = messageHistory.borrowReadOnlyRuntimeEntries();
    expect(after).toHaveLength(before.length);
    expect(memoryEntries(messageHistory)).toHaveLength(1);
    const current = after[oldIndex];
    expect(isRuntimeAttachmentEntry(current) && current.content).toBe("新记忆");
  });

  it("文本没变时不动历史", () => {
    const { runtime, messageHistory } = createRuntime();
    setTeamMemoryContext.call(runtime, { text: "同一份记忆" });
    const replace = vi.spyOn(messageHistory, "replaceMessages");

    const result = setTeamMemoryContext.call(runtime, { text: "同一份记忆" });

    expect(result).toEqual({ ok: true });
    expect(replace).not.toHaveBeenCalled();
  });

  it("有活动 turn 时拒绝，交给下一次叫醒", () => {
    const { runtime, messageHistory } = createRuntime({ id: "active" });

    const result = setTeamMemoryContext.call(runtime, { text: "记忆" });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(memoryEntries(messageHistory)).toHaveLength(0);
  });

  it("空内容不产生空条目", () => {
    const { runtime, messageHistory } = createRuntime();

    expect(setTeamMemoryContext.call(runtime, { text: "   " })).toEqual({ ok: true });
    expect(memoryEntries(messageHistory)).toHaveLength(0);
  });

  it("reset 之后消息历史里不再保留记忆条目", () => {
    const { runtime, messageHistory } = createRuntime();
    setTeamMemoryContext.call(runtime, { text: "旧任务记忆" });
    messageHistory.addUser("旧任务输入");
    expect(memoryEntries(messageHistory)).toHaveLength(1);

    messageHistory.reset();

    expect(memoryEntries(messageHistory)).toHaveLength(0);
  });
});
