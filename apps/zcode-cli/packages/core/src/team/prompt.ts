// ============================================================
// Team Turn Prompt
// ============================================================
// 一个成员被唤醒时看到的全部信息。刻意做成纯函数：同样的状态必然拼出同样的提示，
// 出问题时可复现（每次唤醒都从磁盘装载，没有任何内存里的上下文可以漂移）。
//
// 这里只负责「这一轮」：为什么醒、要处理什么、干完该调哪个工具。
// 身份、岗位、模块边界与会话记忆声明由成员创建时的 system prompt 承担（buildMemberPersona）；
// 每轮重复那些静态内容只会让同一个人每次醒来都重读同一段话。
//
// 成员记忆正文不在这里。调度器在叫醒前读文件，把它作为背景上下文交给 runtime 注入；
// 放进这条用户消息会把「我自己记得什么」和「这一轮要做什么」混成一件事。

import type { TeamMemberRef, TeamMessageRef, TeamTaskRef } from "@zcode/contracts";
import { assignableRoles, hirableRoles } from "./policy.js";
import { roleBrief, roleLabel } from "./roles.js";

export interface TeamTurnContext {
  member: TeamMemberRef;
  members: readonly TeamMemberRef[];
  /** 本轮要处理的消息。调度器只取出未消费的那些。 */
  inbox: readonly TeamMessageRef[];
  tasks: readonly TeamTaskRef[];
  /** 上一轮失败原因。作为恢复信息给模型，而不是让它猜。 */
  failure?: string;
  /** 团队的总目标（用户需求）。 */
  goal: string;
  /**
   * 组建期：这一轮的目标不是把需求做完，而是把团队配齐（分模块、招人、报告编制）。
   * 同一个成员、同一个提示词骨架，只有「现在怎么做」这一段不同。
   */
  staffing?: boolean;
}

function rosterLine(member: TeamMemberRef, selfId: string): string {
  const mark = member.id === selfId ? "（你）" : "";
  const scope = member.module ? ` · 负责 ${member.module}` : " · 未划分模块";
  return `- ${member.name} · ${roleLabel(member.role)}${mark}${scope} · ${member.status}`;
}

function messageLine(message: TeamMessageRef, members: readonly TeamMemberRef[]): string {
  const name = members.find((member) => member.id === message.from)?.name ?? message.from;
  const refs = message.refs.length > 0 ? `\n  引用：${message.refs.join(", ")}` : "";
  return `【${message.kind}】来自 ${name}：\n${message.content}${refs}`;
}

/**
 * 成员的人设（system prompt）。创建 runtime 时写一次；模块或职责改了，
 * team-runtime 在下一轮开始前用同一函数重算并刷新 system prompt，不重建会话。
 */
export function buildMemberPersona(member: TeamMemberRef): string {
  return [
    roleBrief(member.role),
    `这个岗位在本团队里的职责：${member.purpose}`,
    member.module
      ? `你负责的模块：${member.module}。这个范围内的事由你决定；范围外要改，先找负责人商量。`
      : "",
    "你的会话和长期记忆只属于你：同事看不到你的上下文，你也看不到他们的。需要对齐就发消息。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildTeamTurnPrompt(context: TeamTurnContext): string {
  const { member, members, inbox, tasks } = context;
  const openTasks = tasks.filter((task) => task.ownerId === member.id && task.state === "open");
  const hire = hirableRoles(member.role);
  const assign = assignableRoles(member.role);

  const sections: string[] = [];

  // 团队目标每次交付都会重写（startRequirement / beginStaffing），不能固化进创建时的 persona。
  // 模块边界已经从每轮提示移走：它属于 system prompt，改了模块由 runner 在下一轮前刷新。
  sections.push(`团队目标：${context.goal}`);

  sections.push(
    ["团队成员（用名字给他们发消息）：", ...members.map((it) => rosterLine(it, member.id))].join(
      "\n",
    ),
  );

  sections.push(
    [
      "你的权限：",
      hire.length > 0 ? `- 可以招：${hire.map(roleLabel).join("、")}` : "- 不能招人",
      assign.length > 0 ? `- 可以派活给：${assign.map(roleLabel).join("、")}` : "- 不能给别人派活",
      member.role === "supervisor"
        ? "- 不能中途问用户：拿不准就做合理假设，并在最终交付里列出"
        : "- 遇到拿不准的：向上级上报，不要找用户",
    ].join("\n"),
  );

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

  if (context.staffing === true) {
    sections.push(
      [
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
      ].join("\n"),
    );
  } else {
    sections.push(
      [
        "现在怎么做：",
        "1. 只处理上面这些消息要求你做的事，不要顺手扩展需求。",
        "2. 需要别人配合就发消息（MessageTeammate）；要等结果就带 awaitReply。",
        "3. 干完了用 SubmitTask 提交，写清产出路径和验证方式。",
        member.role === "supervisor"
          ? "4. 全队收尾后用 DeliverResult 交付给用户。"
          : "4. 这一轮没有可做的事就直接结束，不要为了说话而说话。",
        "",
        "硬规则：",
        "- 发完消息就结束本轮。你不是在等回复，对方回你时会重新叫醒你。",
        "- 不要臆造文件内容或接口签名；不知道就去问，或去读文件。",
        "- 不要声称做过没做的事。",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
