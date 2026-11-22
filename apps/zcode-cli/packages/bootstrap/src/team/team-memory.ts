// ============================================================
// Team Memory — 每个成员一份独立的长期记忆
// ============================================================
// 成员的会话 transcript 在会话库里，但 runtime 的 messageHistory 只活在进程内：
// 进程重启后新 runtime 是空的，模型看不到自己上一轮做过什么。
//
// 所以记忆要落在**文件**上，而不是靠 runtime 的状态：
//   - 每个成员一份 `.zcode/team/memory/<名字>.md`
//   - 每轮开始把文件尾部注入提示词（它有上限，不会无限膨胀）
//   - 每轮结束自动追加一行「这轮发生了什么」，不需要模型配合
//   - 模型也可以自己往里写模块知识（接口约定、踩过的坑），因为这就是普通文件
//
// 独立是关键：不去读别人的记忆文件。团队共享的是任务板和邮箱，不是脑子。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 注入提示词的上限：记忆是索引，不是全文档案。 */
const INJECT_CHAR_LIMIT = 4_000;

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "member";
}

export function memberMemoryFile(memoryDir: string, memberName: string): string {
  return join(memoryDir, `${safeName(memberName)}.md`);
}

/**
 * 读这个成员自己的记忆，返回可以塞进提示词的片段。
 * 文件不存在就是空的：第一次被叫醒时没有历史，这是正常的。
 */
export function readMemberMemory(memoryDir: string, memberName: string): string {
  const file = memberMemoryFile(memoryDir, memberName);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const body = raw.trim();
  if (body.length === 0) return "";
  if (body.length <= INJECT_CHAR_LIMIT) return body;
  return `（更早的记录已省略，完整内容在 ${file}）\n${body.slice(-INJECT_CHAR_LIMIT)}`;
}

/** 追加一条记录。系统侧维护，不依赖模型是否记得写。 */
export function appendMemberMemory(
  memoryDir: string,
  memberName: string,
  entry: string,
  options: { now?: number } = {},
): void {
  const file = memberMemoryFile(memoryDir, memberName);
  try {
    mkdirSync(memoryDir, { recursive: true });
    if (!existsSync(file)) {
      appendFileSync(
        file,
        [
          `# ${memberName} 的记忆`,
          "",
          "这个文件只属于你。每次你被叫醒时会读到它；模块知识（接口约定、踩过的坑、已定下的事实）",
          "可以用编辑工具追加到这里，下一轮你会看到。",
          "",
          "## 经历",
          "",
        ].join("\n"),
      );
    }
    const at = new Date(options.now ?? Date.now());
    const stamp = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(
      at.getHours(),
    ).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    appendFileSync(file, `- [${stamp}] ${entry}\n`);
  } catch {
    // 记忆写不进去不该让一轮团队工作失败：它只是上下文，不是事实源。
  }
}

/** 把一段可能很长的正文压成一行，用于记录。 */
export function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}
