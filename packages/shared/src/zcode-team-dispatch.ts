// ============================================================
// Team Dispatch Prompts — 「开始组建 / 派任务」按钮与 /team 命令共用
// ============================================================
// 放在 shared 而不是 bootstrap，是因为两个消费方要**逐字一致**：
//   - bootstrap：/team 斜杠命令的展开正文
//   - ui：团队面板按钮直接把这段话作为首条消息发出去（不走斜杠命令管线，
//     程序化提交会被 "/" 命令菜单拦截，用户还得再按一次回车——那不是派发）
//
// 改任何一段文案，两边同时生效；这也是把它们集中在这里的唯一理由。

export function buildTeamStaffingPrompt(): string {
  return [
    "Staff the team for this project. Do not do the work yourself.",
    "",
    "Call the `StartTeam` tool with `mode: \"init\"`. The supervisor will:",
    "1. read this project (structure, README, entry points, existing modules);",
    "2. split it into non-overlapping modules;",
    "3. hire one owner per module, each with an explicit `module` (the files or directories it owns);",
    "4. report the resulting roster.",
    "",
    "When it returns, show the user the roster in a compact table: 名字 · 角色 · 负责模块.",
    "Say plainly which modules ended up uncovered, if any. Do not start implementing anything.",
  ].join("\n");
}

export function buildTeamDeliveryPrompt(requirement: string): string {
  return [
    "Deliver this request with the team agent:",
    "",
    requirement,
    "",
    "Call the `StartTeam` tool with `mode: \"deliver\"` and the request above, quoting the user's wording where it matters.",
    "",
    "- Do NOT start doing the work yourself. The supervisor plans, delegates to the members who own",
    "  each module, and verifies; you are only the hand-off.",
    "- If the team has not been staffed yet (only the supervisor exists), say so and suggest",
    "  running team staffing first — a team hired on the fly has no module owners to delegate to.",
    "- `StartTeam` blocks until the supervisor delivers. When it returns, relay the delivery.",
    "- If it reports a stall, timeout, or cancellation, report that as-is together with what each",
    "  member had finished. Do not silently retry, and do not pretend the work is done.",
    "",
  ].join("\n");
}
