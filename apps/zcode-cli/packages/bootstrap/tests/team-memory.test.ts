// 成员记忆的写入者是 agent 自己：SaveMemory 把总结好的要点交给 team-memory，
// 由它追加到文件；读取时去掉文件头，作为背景资料交给 runtime。
// 这里覆盖：任务/模块知识分段、多行要点、快照去头、截断与背景文本。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSavedMemory,
  formatMemoryContext,
  memberMemoryFile,
  readMemberMemory,
} from "../src/team/team-memory.js";

const dirs: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-memory-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("team memory file", () => {
  it("按 kind 写入任务记忆与模块知识，多行要点各成一条时间线", () => {
    const dir = newDir();

    appendSavedMemory(dir, "组长-办公插件", {
      kind: "task",
      content: "- 改了 dock-plugins/a.ts\n- 验证：typecheck 通过",
    });
    appendSavedMemory(dir, "组长-办公插件", {
      kind: "knowledge",
      content: "接口约定：run() 返回 Promise。",
    });

    const raw = readFileSync(memberMemoryFile(dir, "组长-办公插件"), "utf8");
    expect(raw).toContain("## 任务记忆");
    expect(raw).toContain("## 模块知识");
    expect(raw.match(/^- \[\d{2}-\d{2} \d{2}:\d{2}\] /gm)).toHaveLength(3);

    const snapshot = readMemberMemory(dir, "组长-办公插件");
    expect(snapshot.text).toContain("## 任务记忆");
    expect(snapshot.text).toContain("改了 dock-plugins/a.ts");
    expect(snapshot.text).toContain("验证：typecheck 通过");
    expect(snapshot.text).toContain("接口约定");
    expect(snapshot.truncated).toBe(false);
  });

  it("读取时去掉文件标题和模板说明，只留记录正文", () => {
    const dir = newDir();
    appendSavedMemory(dir, "组长", { kind: "task", content: "任务要点" });

    const snapshot = readMemberMemory(dir, "组长");

    expect(snapshot.text).not.toContain("这个文件只属于你");
    expect(snapshot.text).not.toContain("用 SaveMemory 追加新要点");
    expect(snapshot.text.startsWith("## 任务记忆")).toBe(true);
    expect(snapshot.text).toContain("任务要点");
  });

  it("文件不存在时返回空快照，不创建文件", () => {
    const dir = newDir();

    const snapshot = readMemberMemory(dir, "还没被叫醒的成员");

    expect(snapshot.text).toBe("");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.file.endsWith("还没被叫醒的成员.md")).toBe(true);
  });

  it("超过注入上限时保留尾部并标记截断", () => {
    const dir = newDir();
    appendSavedMemory(dir, "组长", { kind: "task", content: "x".repeat(5_000) });

    const snapshot = readMemberMemory(dir, "组长");

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toHaveLength(4_000);
    expect(formatMemoryContext(snapshot)).toContain("更早的记录已省略");
  });
});

describe("formatMemoryContext", () => {
  it("没有记录时不生成背景条目", () => {
    const dir = newDir();
    expect(formatMemoryContext(readMemberMemory(dir, "组长"))).toBe("");
  });

  it("明确标注是背景资料、可能过期，并给出完整记录路径", () => {
    const dir = newDir();
    appendSavedMemory(dir, "组长", { kind: "task", content: "任务要点" });

    const context = formatMemoryContext(readMemberMemory(dir, "组长"));

    expect(context).toContain("背景资料，不是本轮指令");
    expect(context).toContain("可能已经过期");
    expect(context).toContain("完整记录：");
    expect(context).toContain("需要更早的内容可以用 Read 查看");
    expect(context).toContain("任务要点");
  });
});
