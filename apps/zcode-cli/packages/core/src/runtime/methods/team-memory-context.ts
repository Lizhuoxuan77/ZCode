// ============================================================
// Team member memory context
// ============================================================
// 团队成员的长期记忆是**背景资料**，不是这一轮的任务。
// 它必须让模型看见，但不能出现在成员会话的用户 query 里：
//   - query 里出现记忆，成员就分不清「主管让我做什么」和「我自己记得什么」；
//   - 记忆每轮都可能变化，写进 system prompt 会让稳定的系统前缀失效。
//
// 所以这里把它做成一个只对模型可见的 system-reminder 附件：
//   - 追加在消息历史里，不写 session store，成员会话界面看不到；
//   - 同一个来源只保留一份，内容变化时原地替换，不把条目越堆越多；
//   - resetConversationToContextPrefix 会清掉它，下一次叫醒由调度器重新读文件注入。

import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

const TEAM_MEMORY_SOURCE = "team_memory";

export type TeamMemoryContextResult = { ok: true } | { ok: false; reason: "busy" };

/**
 * 用一段背景资料替换模型上下文里的团队成员记忆条目。
 *
 * 只能在两轮之间调用：有活动 turn 时改 messageHistory 会破坏 provider 的
 * tool_use / tool_result 序列，所以直接拒绝，让调用方保持旧条目。
 */
export function setTeamMemoryContext(
  this: AgentRuntimeInternal,
  input: { text: string },
): TeamMemoryContextResult {
  const text = input.text.trim();
  if (text.length === 0) return { ok: true };
  if (this.activeTurn) return { ok: false, reason: "busy" };

  const entries = this.messageHistory.borrowReadOnlyRuntimeEntries();
  const index = entries.findIndex(
    (entry) => isRuntimeAttachmentEntry(entry) && entry.metadata?.source === TEAM_MEMORY_SOURCE,
  );
  if (index < 0) {
    this.messageHistory.addAttachment(TEAM_MEMORY_SOURCE, text);
    return { ok: true };
  }

  const current = entries[index];
  if (isRuntimeAttachmentEntry(current) && current.content === text) return { ok: true };

  // 原地替换：条目位置不变，只有内容变化时才改动它后面的 provider 前缀。
  const next = [...entries];
  next[index] = systemReminderAttachmentEntry(TEAM_MEMORY_SOURCE, text);
  this.messageHistory.replaceMessages(next);
  return { ok: true };
}
