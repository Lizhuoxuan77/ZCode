#!/usr/bin/env node
// 团队状态只读查看器（终端版）。
//
// 为什么先有它：可视化面板要接侧栏标签、打开器、渲染分支与入口按钮，是多处接线；
// 而团队状态本身已经能从 team.db 读出来了。这个脚本让「看不见团队」这件事先有个兜底，
// 也顺便当面板的数据通路验收工具——面板显示不对时，先跑它看数据对不对。
//
// 用法：node scripts/team-status.mjs [workspacePath]

import { readTeamSnapshot } from "../packages/services/dist/zcode-agent/teamSnapshot.js";

const workspacePath = process.argv[2] ?? process.cwd();
const snapshot = readTeamSnapshot({ workspacePath, messageLimit: 12 });

if (!snapshot.configured) {
  console.log(`团队未启用：${workspacePath} 下没有 .zcode/team.json`);
  process.exit(0);
}
if (!snapshot.started) {
  console.log("团队已启用，但还没跑过任务（没有 team.db）。用 /team <需求> 发起一次。");
  process.exit(0);
}

const DOT = { idle: "○", running: "●", waiting: "◐", failed: "✕", archived: "-" };

console.log(`目标：${snapshot.goal ?? "(未记录)"}`);
if (snapshot.delivery) console.log(`交付：${snapshot.delivery.split("\n")[0]}`);

console.log("\n组织");
const byParent = new Map();
for (const member of snapshot.members) {
  const key = member.parentId ?? "root";
  byParent.set(key, [...(byParent.get(key) ?? []), member]);
}
const walk = (parentId, depth) => {
  for (const member of byParent.get(parentId) ?? []) {
    const indent = "  ".repeat(depth);
    const tasks = snapshot.tasks.filter(
      (task) => task.ownerId === member.id && task.state === "open",
    );
    const doing = tasks.length > 0 ? `  ← ${tasks[0].title}` : "";
    console.log(`${indent}${DOT[member.status] ?? "?"} ${member.name}（${member.role}）${doing}`);
    walk(member.id, depth + 1);
  }
};
walk("root", 1);

const open = snapshot.tasks.filter((task) => task.state === "open");
console.log(`\n任务：${snapshot.tasks.length} 条，进行中 ${open.length} 条`);
for (const task of snapshot.tasks.slice(0, 8)) {
  const revision = task.revision > 0 ? ` 退回 ${task.revision} 次` : "";
  console.log(`  [${task.state}] ${task.title} — ${task.ownerName}${revision}`);
}

console.log("\n最近消息");
for (const message of snapshot.messages.slice(-8)) {
  const body = message.content.replace(/\s+/g, " ").slice(0, 70);
  console.log(`  【${message.kind}】${message.fromName} → ${message.toName}：${body}…`);
}
