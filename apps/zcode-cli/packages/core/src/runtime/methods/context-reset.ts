// ============================================================
// Conversation reset — 回到 context prefix，丢掉上一段任务对话
// ============================================================
// 团队任务级隔离用：任务完成并把要点写进成员记忆后，下一次新任务开始前调用。
// 只清 provider-visible 的 messageHistory；session store 里的 transcript、消息 id、
// sequence number 全部保留，界面仍能看到完整历史。
//
// 为什么是 reset + rebuildContextPrefix，而不是 compact/rewind/fork：
//   - compact 会留一条摘要消息和一个持久压缩边界，仍是“上一段上下文”；
//   - rewind 会从 session store 重新水合旧分支，等于把旧对话装回来；
//   - fork 会创建新会话，破坏“成员 = 一个可见会话”的身份。
// reset() 只保留 leading context prefix；此时 canonical conversation 为空，
// rebuildContextPrefix 只会装回新的 system 前缀。

import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createTotalTokensBudgetState } from "../helpers/total-tokens-budget.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { setReadFileStateEntry } from "../../tool/read-file-state.js";
import { rebuildContextPrefix } from "./context-refresh.js";

export type ConversationResetResult = { ok: true } | { ok: false; reason: "busy" | "locked" };

/**
 * 回到 context prefix。只能在两轮之间调用。
 *
 * 不写任何 session 事件，也不删除持久 transcript：模型看不到旧任务，
 * 审计/界面仍能看到。调用方（团队调度器）负责在“任务范围已关闭、且下一个新任务开始前”
 * 这个时机调用。
 */
export function resetConversationToContextPrefix(
  this: AgentRuntimeInternal,
  options: { model?: Model } = {},
): ConversationResetResult {
  // 运行中的 turn / 后台 Bash / 子代理 / 排队输入都会在 reset 之后继续往 history 写，
  // 或者依赖旧 history；此时必须拒绝，由调用方保留「待清空」标志等下一轮。
  if (
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.hasResidencyBlockingWork()
  ) {
    return { ok: false, reason: "busy" };
  }
  if (
    this.pendingInputReservations.size > 0 ||
    this.pendingInputEditLocks.size > 0 ||
    this.activeTurnStartReservation !== undefined
  ) {
    return { ok: false, reason: "locked" };
  }

  // 只保留 system/context prefix；随后 prefix 重建会把 context prefix 装回来。
  this.messageHistory.reset();
  if (this.contextInitialized) {
    rebuildContextPrefix(this, { model: options.model });
  }

  // 任务级工具/计数状态。保留 seededFromContext（MEMORY.md 索引）的读写守卫；
  // 团队记忆文件不在其中，模型下一次需要重新 Read 再 Edit。
  const seeded = [...this.readFileState.values()].filter(
    (entry) => entry.seededFromContext === true,
  );
  this.readFileState.clear();
  for (const entry of seeded) setReadFileStateEntry(this.readFileState, entry);

  resetProjectMemoryRecall(this);
  this.totalTokensBudget = createTotalTokensBudgetState();
  this.autoCompactConsecutiveFailures = 0;
  this.currentTurnFileChanges = new Map();
  this.lastAssistantCompletedAtMs = undefined;
  this.pendingMemoryUpdate = undefined;
  this.messageHistory.setCacheMiss();

  return { ok: true };
}
