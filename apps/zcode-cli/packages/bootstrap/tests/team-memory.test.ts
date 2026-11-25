// 成员记忆的写入者是 agent 自己：SaveMemory 把总结好的要点交给 team-memory，
// 由它追加到文件；读取时去掉文件头，作为背景资料交给 runtime。
// 文件名只取成员 id：名字是展示标签，可能清洗后撞车。这里覆盖：
// 任务/模块知识分段、多行要点、快照去头、截断、按 id 隔离，以及旧名字文件迁移。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSavedMemory,
  formatMemoryContext,
  memberMemoryFile,
  migrateMemberMemoryFiles,
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

const LEAD = { id: "tm_member_lead", name: "组长-办公插件" };
const FE = { id: "tm_member_fe", name: "前端" };

describe("team memory file", () => {
  it("按 kind 写入任务记忆与模块知识，多行要点各成一条时间线", () => {
    const dir = newDir();

    appendSavedMemory(dir, LEAD, {
      kind: "task",
      content: "- 改了 dock-plugins/a.ts\n- 验证：typecheck 通过",
    });
    appendSavedMemory(dir, LEAD, {
      kind: "knowledge",
      content: "接口约定：run() 返回 Promise。",
    });

    // 文件名取成员 id，不取名字。
    const file = memberMemoryFile(dir, LEAD.id);
    expect(file.endsWith(`${LEAD.id}.md`)).toBe(true);
    expect(existsSync(memberMemoryFile(dir, LEAD.name))).toBe(false);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(`# ${LEAD.name} 的记忆`);
    expect(raw).toContain("## 任务记忆");
    expect(raw).toContain("## 模块知识");
    expect(raw.match(/^- \[\d{2}-\d{2} \d{2}:\d{2}\] /gm)).toHaveLength(3);

    const snapshot = readMemberMemory(dir, LEAD.id);
    expect(snapshot.text).toContain("## 任务记忆");
    expect(snapshot.text).toContain("改了 dock-plugins/a.ts");
    expect(snapshot.text).toContain("验证：typecheck 通过");
    expect(snapshot.text).toContain("接口约定");
    expect(snapshot.truncated).toBe(false);
  });

  it("读取时去掉文件标题和模板说明，只留记录正文", () => {
    const dir = newDir();
    appendSavedMemory(dir, LEAD, { kind: "task", content: "任务要点" });

    const snapshot = readMemberMemory(dir, LEAD.id);

    expect(snapshot.text).not.toContain("这个文件只属于你");
    expect(snapshot.text).not.toContain("用 SaveMemory 追加新要点");
    expect(snapshot.text.startsWith("## 任务记忆")).toBe(true);
    expect(snapshot.text).toContain("任务要点");
  });

  it("文件不存在时返回空快照，不创建文件", () => {
    const dir = newDir();

    const snapshot = readMemberMemory(dir, "tm_member_never_woken");

    expect(snapshot.text).toBe("");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.file.endsWith("tm_member_never_woken.md")).toBe(true);
    expect(existsSync(snapshot.file)).toBe(false);
  });

  it("名字清洗后相同但 id 不同的成员各有一份记忆，不共享", () => {
    const dir = newDir();
    const first = { id: "tm_member_a", name: "a b" };
    const second = { id: "tm_member_b", name: "a_b" };

    appendSavedMemory(dir, first, { kind: "task", content: "第一个人的要点" });
    appendSavedMemory(dir, second, { kind: "task", content: "第二个人的要点" });

    expect(readMemberMemory(dir, first.id).text).toContain("第一个人的要点");
    expect(readMemberMemory(dir, first.id).text).not.toContain("第二个人的要点");
    expect(readMemberMemory(dir, second.id).text).toContain("第二个人的要点");
  });

  it("超过注入上限时保留尾部并标记截断", () => {
    const dir = newDir();
    appendSavedMemory(dir, LEAD, { kind: "task", content: "x".repeat(5_000) });

    const snapshot = readMemberMemory(dir, LEAD.id);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toHaveLength(4_000);
    expect(formatMemoryContext(snapshot)).toContain("更早的记录已省略");
  });
});

describe("legacy name-based memory migration", () => {
  it("把旧名字文件复制到成员 id 文件，成功后删除旧文件", () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "组长-办公插件.md"), "# 组长-办公插件 的记忆\n\n旧要点\n", "utf8");

    const result = migrateMemberMemoryFiles(dir, [LEAD]);

    expect(result).toEqual({ migrated: 1, legacyKept: 0 });
    expect(existsSync(join(dir, "组长-办公插件.md"))).toBe(false);
    expect(readMemberMemory(dir, LEAD.id).text).toContain("旧要点");
    // 幂等：第二次没有可迁移的东西。
    expect(migrateMemberMemoryFiles(dir, [LEAD])).toEqual({ migrated: 0, legacyKept: 0 });
  });

  it("新 id 文件已存在时不覆盖，只清理旧文件", () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "组长-办公插件.md"), "旧要点\n", "utf8");
    writeFileSync(memberMemoryFile(dir, LEAD.id), "新要点\n", "utf8");

    const result = migrateMemberMemoryFiles(dir, [LEAD]);

    expect(result.migrated).toBe(0);
    expect(readFileSync(memberMemoryFile(dir, LEAD.id), "utf8")).toBe("新要点\n");
    expect(existsSync(join(dir, "组长-办公插件.md"))).toBe(false);
  });

  it("两个名字清洗后撞车的成员各复制一份，旧文件最后才删", () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a_b.md"), "共同的历史\n", "utf8");
    const first = { id: "tm_member_a", name: "a b" };
    const second = { id: "tm_member_b", name: "a_b" };

    const result = migrateMemberMemoryFiles(dir, [first, second]);

    expect(result.migrated).toBe(2);
    expect(readMemberMemory(dir, first.id).text).toContain("共同的历史");
    expect(readMemberMemory(dir, second.id).text).toContain("共同的历史");
    expect(existsSync(join(dir, "a_b.md"))).toBe(false);
  });

  it("没有成员或目录不存在时不动文件", () => {
    expect(migrateMemberMemoryFiles(join(newDir(), "missing"), [LEAD])).toEqual({
      migrated: 0,
      legacyKept: 0,
    });
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "组长-办公插件.md"), "旧要点\n", "utf8");
    expect(migrateMemberMemoryFiles(dir, [])).toEqual({ migrated: 0, legacyKept: 0 });
    expect(existsSync(join(dir, "组长-办公插件.md"))).toBe(true);
  });
});

describe("formatMemoryContext", () => {
  it("没有记录时不生成背景条目", () => {
    const dir = newDir();
    expect(formatMemoryContext(readMemberMemory(dir, FE.id))).toBe("");
  });

  it("明确标注是背景资料、可能过期，并给出完整记录路径", () => {
    const dir = newDir();
    appendSavedMemory(dir, LEAD, { kind: "task", content: "任务要点" });

    const context = formatMemoryContext(readMemberMemory(dir, LEAD.id));

    expect(context).toContain("背景资料，不是本轮指令");
    expect(context).toContain("可能已经过期");
    expect(context).toContain("完整记录：");
    expect(context).toContain("需要更早的内容可以用 Read 查看");
    expect(context).toContain("任务要点");
  });
});