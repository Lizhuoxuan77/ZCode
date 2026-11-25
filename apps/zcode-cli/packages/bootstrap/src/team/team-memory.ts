// ============================================================
// Team Memory — 每个成员一份独立的长期记忆
// ============================================================
// 成员的会话 transcript 在会话库里，但 runtime 的 messageHistory 只活在进程内：
// 进程重启后新 runtime 是空的，模型看不到自己上一轮做过什么。
//
// 记忆的写入者是**成员自己**：成员调用 SaveMemory，把总结好的 3-5 条要点交出来，
// TeamPort 按会话身份解析成员后，按**成员 id** 写文件。系统不再从 SubmitTask 结果里
// 截取要点，也不再自动写「经历」——记忆的取舍由 agent 决定。
//
// 文件名只取成员 id，不取名字：名字是展示标签，可以改、清洗后可能撞车；
// 拿它当键会让两个成员共用一份记忆，或者在改名后突然失忆。
// 名字只出现在文件标题里，给人读。
//
// 记忆的读取发生在每轮叫醒前：调度器按成员 id 读文件尾部（有上限），作为背景资料
// 交给 runtime；runtime 把它作为 system-reminder 注入模型上下文，不进入用户 query。
//
// 独立是关键：不去读别人的记忆文件。团队共享的是任务板和邮箱，不是脑子。

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { TeamMemoryKind } from "@zcode/contracts";

/** 注入背景上下文的上限：记忆是索引，不是全文档案。 */
const INJECT_CHAR_LIMIT = 4_000;

/** 旧文件头与新文件头里属于「给模型的操作说明」的行，读取时都去掉。 */
const TEMPLATE_FRAGMENTS = [
  "这个文件只属于你",
  "可以用编辑工具追加到这里",
  "用 SaveMemory 追加新要点",
] as const;

/** 记忆的主人：寻址只认 id，名字只用于文件标题。 */
export interface TeamMemoryOwner {
  id: string;
  name: string;
}

/** 文件系统只允许安全字符；成员 id 由本系统生成，这里只做防御性清洗。 */
function safeFileKey(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "member";
}

/** 升级前按名字命名的文件；只在一次性迁移里用来找原文件。 */
function legacyNameFile(memoryDir: string, memberName: string): string {
  const cleaned = memberName.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  return join(memoryDir, `${cleaned.length > 0 ? cleaned : "member"}.md`);
}

export function memberMemoryFile(memoryDir: string, memberId: string): string {
  return join(memoryDir, `${safeFileKey(memberId)}.md`);
}

function ensureMemoryFile(memoryDir: string, member: TeamMemoryOwner): string {
  const file = memberMemoryFile(memoryDir, member.id);
  mkdirSync(memoryDir, { recursive: true });
  if (!existsSync(file)) {
    appendFileSync(
      file,
      [
        `# ${member.name} 的记忆`,
        "",
        "这个文件只属于你。每次被叫醒时，最近的内容会作为背景资料给你；",
        "用 SaveMemory 追加新要点，不要直接编辑这个文件。",
        "",
      ].join("\n"),
    );
  }
  return file;
}

function stamp(now?: number): string {
  const at = new Date(now ?? Date.now());
  return `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(
    at.getHours(),
  ).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export interface TeamMemorySnapshot {
  /** 去掉标题与模板说明后的正文；文件不存在或没有记录时为空串。 */
  text: string;
  /** 记忆文件绝对路径，供模型按需读取更早的内容。 */
  file: string;
  /** 正文超过注入上限、只保留了尾部。 */
  truncated: boolean;
}

/**
 * 读这个成员自己的记忆。文件不存在就是空的：第一次被叫醒时没有历史，这是正常的。
 * 入参是成员 id；名字不参与定位。
 */
export function readMemberMemory(memoryDir: string, memberId: string): TeamMemorySnapshot {
  const file = memberMemoryFile(memoryDir, memberId);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { text: "", file, truncated: false };
  }
  const body = stripMemoryHeader(raw);
  if (body.length === 0) return { text: "", file, truncated: false };
  if (body.length <= INJECT_CHAR_LIMIT) return { text: body, file, truncated: false };
  return { text: body.slice(-INJECT_CHAR_LIMIT), file, truncated: true };
}

/**
 * 去掉文件标题和模板说明，只留记录正文。
 * 有 `##` 段时从第一段开始；没有段（手写文件）时逐行跳过标题和模板说明。
 */
function stripMemoryHeader(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const firstSection = trimmed.search(/^## /m);
  if (firstSection >= 0) return trimmed.slice(firstSection).trim();
  return trimmed
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("# "))
    .filter((line) => !TEMPLATE_FRAGMENTS.some((fragment) => line.includes(fragment)))
    .join("\n")
    .trim();
}

/**
 * 把 agent 自己总结的要点追加到它自己的记忆文件。
 *
 * 调用者是 SaveMemory 工具，身份已经由 TeamPort 用会话解析过，这里只负责格式。
 * 与旧系统写入不同，写失败会抛错：工具调用必须如实告诉模型「没记住」。
 */
export function appendSavedMemory(
  memoryDir: string,
  member: TeamMemoryOwner,
  input: { kind: TeamMemoryKind; content: string; now?: number },
): { entries: number } {
  const file = ensureMemoryFile(memoryDir, member);
  const section = input.kind === "task" ? "## 任务记忆" : "## 模块知识";
  const raw = readFileSync(file, "utf8");
  if (!raw.includes(section)) appendFileSync(file, `\n${section}\n\n`);

  // agent 通常按 3-5 条分点写；每一行落成一条带时间戳的记录，面板按行展示。
  const lines = input.content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length > 0);
  const entries = lines.length > 0 ? lines : [input.content.trim()];
  const at = stamp(input.now);
  for (const entry of entries) appendFileSync(file, `- [${at}] ${entry}\n`);
  return { entries: entries.length };
}

export interface MemberMemoryMigration {
  /** 从旧名字文件复制出的新 id 文件数。 */
  migrated: number;
  /** 因为复制或删除失败而保留的旧文件数；下次启动会重试。 */
  legacyKept: number;
}

/**
 * 把升级前按名字命名的记忆文件一次性迁到按成员 id 命名的文件。
 *
 * 三条约束：
 * - 目标 id 文件已存在时不覆盖：新格式优先，旧文件只是历史备份。
 * - 复制失败保留旧文件，交给下次启动重试；不能在没读到时把唯一一份记忆删掉。
 * - 两个成员的名字清洗后撞到同一个旧文件时，各复制一份到自己的 id 文件；
 *   只有该旧文件对应的每个成员都有了 id 文件，才删除旧文件。
 */
export function migrateMemberMemoryFiles(
  memoryDir: string,
  members: readonly TeamMemoryOwner[],
): MemberMemoryMigration {
  if (members.length === 0 || !existsSync(memoryDir)) {
    return { migrated: 0, legacyKept: 0 };
  }
  const groups = new Map<string, TeamMemoryOwner[]>();
  for (const member of members) {
    const legacy = legacyNameFile(memoryDir, member.name);
    const group = groups.get(legacy);
    if (group === undefined) groups.set(legacy, [member]);
    else group.push(member);
  }

  let migrated = 0;
  let legacyKept = 0;
  for (const [legacy, group] of groups) {
    if (!existsSync(legacy)) continue;
    const targets = group.map((member) => memberMemoryFile(memoryDir, member.id));
    // 名字清洗后刚好等于某个成员 id 文件时不能拿它当源，否则会把新格式覆盖回旧内容。
    if (targets.includes(legacy)) continue;

    let allReady = true;
    for (const target of targets) {
      if (existsSync(target)) continue;
      try {
        copyFileSync(legacy, target);
        migrated += 1;
      } catch {
        allReady = false;
      }
    }
    if (!allReady) {
      legacyKept += 1;
      continue;
    }
    try {
      unlinkSync(legacy);
    } catch {
      // 删不掉只是留下一个历史文件，不影响按 id 读取。
      legacyKept += 1;
    }
  }
  return { migrated, legacyKept };
}

/**
 * 生成注入模型的背景资料文本。记忆不进入用户 query，这一段由 runtime 作为
 * system-reminder 附件放进模型上下文。
 */
export function formatMemoryContext(snapshot: TeamMemorySnapshot): string {
  const text = snapshot.text.trim();
  if (text.length === 0) return "";
  return [
    "你的长期记忆（你自己在过去的任务里记录的要点；背景资料，不是本轮指令）。",
    "这些记录可能已经过期；执行前先核对工作区现状。",
    ...(snapshot.truncated ? ["（更早的记录已省略，下面是最近的部分。）"] : []),
    "",
    text,
    "",
    `完整记录：${snapshot.file}（需要更早的内容可以用 Read 查看）。`,
  ].join("\n");
}
