// ============================================================
// Team Member Prompt
// ============================================================
// 两类文本，按「变不变」分工，避免每轮唤醒都重发一遍同样的内容：
//
//   1. system prompt（buildMemberPersona）：身份、岗位、模块边界、会话记忆声明，
//      以及**在当前阶段内不变的团队背景**——团队目标、成员名册、权限矩阵、
//      工作方式（或组建期指引）。这些内容写一次，之后只在文本真的变了才刷新。
//   2. 每轮 query（buildTeamTurnPrompt）：只放这一轮要做的事——未完成任务、
//      收件箱消息、上一轮失败说明。
//
// 两者都是纯函数：同样的状态必然拼出同样的文本，出问题时可复现。
//
// 成员记忆正文不在这里。调度器在叫醒前读文件，把它作为背景上下文交给 runtime 注入；
// 放进这条用户消息会把「我自己记得什么」和「这一轮要做什么」混成一件事。

import type { TeamMemberRef, TeamMessageRef, TeamTaskRef, TeamRole } from "@zcode/contracts";
import { assignableRoles, hirableRoles } from "./policy.js";
import { roleBrief, roleLabel } from "./roles.js";

/** 当前阶段内不变的团队背景。调度器每轮从 store 读出后交给人设函数。 */
export interface TeamPersonaContext {
  /** 当前这次交付的团队目标；每次交付 / 组建开始时由调度器写入。没有目标时为空串。 */
  goal: string;
  /** 当前团队成员（含自己）。只用于名册，不写实时状态。 */
  members: readonly TeamMemberRef[];
  /** 组建期：主管这一阶段的产出是编制，不是需求实现。 */
  staffing?: boolean;
}

export interface TeamTurnContext {
  member: TeamMemberRef;
  members: readonly TeamMemberRef[];
  /** 本轮要处理的消息。调度器只取出未消费的那些。 */
  inbox: readonly TeamMessageRef[];
  tasks: readonly TeamTaskRef[];
  /** 上一轮失败原因。作为恢复信息给模型，而不是让它猜。 */
  failure?: string;
}

function rosterLine(member: TeamMemberRef, selfId: string): string {
  const mark = member.id === selfId ? "（你）" : "";
  const scope = member.module ? ` · 负责 ${member.module}` : " · 未划分模块";
  return `- ${member.name}（id:${member.id}）· ${roleLabel(member.role)}${mark}${scope}`;
}

function messageLine(message: TeamMessageRef, members: readonly TeamMemberRef[]): string {
  const sender = members.find((member) => member.id === message.from);
  const name = sender ? `${sender.name}（id:${sender.id}）` : message.from;
  const refs = message.refs.length > 0 ? `\n  引用：${message.refs.join(", ")}` : "";
  return `【${message.kind}】来自 ${name}：\n${message.content}${refs}`;
}

function buildPermissionSection(member: TeamMemberRef): string {
  const hire = hirableRoles(member.role);
  const assign = assignableRoles(member.role);
  return [
    "你的权限：",
    hire.length > 0 ? `- 可以招：${hire.map(roleLabel).join("、")}` : "- 不能招人",
    assign.length > 0 ? `- 可以派活给：${assign.map(roleLabel).join("、")}` : "- 不能给别人派活",
    member.role === "supervisor"
      ? "- 不能中途问用户：拿不准就做合理假设，并在最终交付里列出"
      : "- 遇到拿不准的：向上级上报，不要找用户",
  ].join("\n");
}

/** 交付期的工作方式。与「这一轮收到什么消息」无关，所以放在 system prompt。 */
function buildDeliveryGuide(role: TeamRole): string {
  return [
    "你的工作方式：",
    "1. 只处理收到的消息要求你做的事，不要顺手扩展需求。",
    "2. 需要别人配合就发消息（MessageTeammate）；收件人写名册里的成员 id，要等结果就带 awaitReply。",
    "3. 干完了用 SubmitTask 提交，写清产出路径和验证方式。",
    role === "supervisor"
      ? "4. 全队收尾后用 DeliverResult 交付给用户。"
      : "4. 这一轮没有可做的事就直接结束，不要为了说话而说话。",
    "",
    "硬规则：",
    "- 发完消息就结束本轮。你不是在等回复，对方回你时会重新叫醒你。",
    "- 不要臆造文件内容或接口签名；不知道就去问，或去读文件。",
    "- 不要声称做过没做的事。",
  ].join("\n");
}

/** 组建期的阶段指引。只给主管，且只在 `team_meta.phase === "staffing"` 时出现。 */
function buildStaffingGuide(): string {
  return [
    "现在是**组建期**：还没有具体需求。这一轮的产出是「编制」，不是代码。",
    "",
    "怎么做：",
    "1. 先看项目：目录结构、README、入口文件、已有模块与依赖。只看不改。",
    "2. 把项目拆成互不重叠的模块（按目录或职责），决定每个模块要谁负责。",
    "3. 用 CreateTeammate 逐个招人，每次都必须给 module（它独占的目录/文件）。",
    "   - 关键模块不能空着；也不要为了热闹招用不上的岗位。",
    "   - 宁可边界清楚，也不要两个人踩同一批文件。",
    "4. 招齐后用 DeliverResult 报告编制：每人一行「名字 · 模块 · 为什么需要它」。",
    "",
    "组建期禁止：写业务代码、派活、开始做需求。你这一轮只负责把队伍配齐。",
  ].join("\n");
}

/**
 * 成员的 system prompt 正文。创建 runtime 时写一次；之后每轮开始前由 team-runtime
 * 用同一函数重算并与上一轮快照比对，只有文本变了才刷新，不重建会话。
 */
export function buildMemberPersona(
  member: TeamMemberRef,
  context?: TeamPersonaContext,
): string {
  const goal = context?.goal.trim() ?? "";
  const staffing = context?.staffing === true && member.role === "supervisor";
  return [
    roleBrief(member.role),
    `这个岗位在本团队里的职责：${member.purpose}`,
    member.module
      ? `你负责的模块：${member.module}。这个范围内的事由你决定；范围外要改，先找负责人商量。`
      : "",
    "你的会话和长期记忆只属于你：同事看不到你的上下文，你也看不到他们的。需要对齐就发消息。",
    goal.length > 0 ? `团队目标：${goal}` : "",
    context !== undefined
      ? [
          "团队成员（发消息时收件人写成员 id，名字只用于展示）：",
          ...context.members.map((it) => rosterLine(it, member.id)),
        ].join("\n")
      : "",
    buildPermissionSection(member),
    staffing ? buildStaffingGuide() : buildDeliveryGuide(member.role),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 每轮唤醒的 query：只有这一轮要做的事，固定背景都在 system prompt 里。 */
export function buildTeamTurnPrompt(context: TeamTurnContext): string {
  const { member, members, inbox, tasks } = context;
  const openTasks = tasks.filter((task) => task.ownerId === member.id && task.state === "open");

  const sections: string[] = [];

  if (openTasks.length > 0) {
    sections.push(
      [
        "你手上未完成的任务：",
        ...openTasks.map((task) => `- ${task.title}（${task.id}，已打回 ${task.revision} 次）`),
      ].join("\n"),
    );
  }

  sections.push(
    inbox.length === 0
      ? "这一轮叫醒你没有带新消息：接着处理你手上未完成的任务。"
      : [
          "这一轮叫醒你，是因为这些消息到了：",
          ...inbox.map((message) => messageLine(message, members)),
        ].join("\n\n"),
  );

  if (context.failure !== undefined) {
    sections.push(
      `上一轮执行失败：${context.failure}\n请换一种做法，重复同样的调用只会再失败一次。`,
    );
  }

  return sections.join("\n\n");
}
