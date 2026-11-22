// ============================================================
// Team Agent — 内核
// ============================================================
// 这里只有三类东西，刻意不含调度器与存储：
//   - roles：岗位与职责（给模型看的话）
//   - policy：权限矩阵（给代码执行的规则）
//   - prompt：一次唤醒的完整输入（纯函数，同样的状态拼出同样的提示）
//
// 调度器与 SQLite 落在宿主侧（apps/zcode-cli/packages/bootstrap/src/team）：
// 它要 node:sqlite 与真实 AgentRuntime，core 保持平台中立。

export * from "./roles.js";
export * from "./policy.js";
export * from "./prompt.js";
