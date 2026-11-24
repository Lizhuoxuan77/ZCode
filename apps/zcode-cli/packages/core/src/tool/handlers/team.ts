// ============================================================
// Team Agent Tool Handlers
// ============================================================
// 四个工具只在注入了 TeamPort 的会话里注册（端口在场即注册，与任务类型无关）：
//   - 团队成员的会话：全部四个
//   - 主会话：不注册（它不是成员，用户通过主管提需求）
//
// 所有权限判定都走 core/team/policy.ts，handler 不解释规则。被拒时返回
// ToolHandlerFailure——模型看得见原因并会改道（上报、换个对象），抛异常则只会看到
// 一段栈，学不到「我该找谁」。

import {
  CoreErrorType,
  TEAM_CREATE_MEMBER_TOOL_NAME,
  TEAM_DELIVER_TOOL_NAME,
  TEAM_MESSAGE_TOOL_NAME,
  TEAM_SAVE_MEMORY_TOOL_NAME,
  TEAM_START_TOOL_NAME,
  TEAM_SUBMIT_TOOL_NAME,
  TeamCreateMemberInputJsonSchema,
  TeamCreateMemberInputSchema,
  TeamDeliverInputJsonSchema,
  TeamDeliverInputSchema,
  TeamFlowError,
  TeamMessageInputJsonSchema,
  TeamMessageInputSchema,
  TeamSaveMemoryInputJsonSchema,
  TeamSaveMemoryInputSchema,
  TeamStartInputJsonSchema,
  TeamStartInputSchema,
  TeamSubmitInputJsonSchema,
  TeamSubmitInputSchema,
  createCoreError,
  type TeamCreateMemberInput,
  type TeamDeliverInput,
  type TeamMessageInput,
  type TeamSaveMemoryInput,
  type TeamStartInput,
  type TeamSubmitInput,
  type ToolPermissionPatternSource,
} from "@zcode/contracts";
import { canAssign, canDeliver, canHire, canReject, canSubmit } from "../../team/policy.js";
import { roleLabel } from "../../team/roles.js";
import { isToolHandlerFailure } from "../executor/errors.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler, ToolHandlerFailure } from "../types.js";

/** 业务性拒绝（模型可读、可改道）。与配置故障分开：那种要抛 ConfigurationError。 */
const REJECTED = 1;

function fail(message: string): ToolHandlerFailure {
  return { result: false, errorCode: REJECTED, message };
}

/**
 * 端口会拒绝几种业务流（问答链熔断、退回超限、重复提交）。这些不是故障，
 * 是模型该知道并改道的规则——转成业务失败，别让它读一段栈。
 *
 * 判别失败只能用失败对象独有的字段：TeamTaskRef 本身带 result（提交正文），
 * 用 `"result" in` 会把成功提交误判成失败，executor 随后按失败投影并触发
 * outputSchema 校验（2026-11-23 实测 9 次成功提交全部被报成格式错误）。
 */
function guard<T>(fn: () => T): T | ToolHandlerFailure {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TeamFlowError) return fail(error.message);
    throw error;
  }
}

function sendOrFail(
  port: NonNullable<ToolExecutionContext["teamPort"]>,
  input: Parameters<NonNullable<ToolExecutionContext["teamPort"]>["send"]>[0],
) {
  return guard(() => port.send(input));
}

function requireTeamMember(context: ToolExecutionContext, tool: string) {
  const port = context.teamPort;
  if (!port) {
    throw createCoreError(CoreErrorType.ConfigurationError, `Team port is not configured for ${tool}`, {
      context: { toolCallId: context.toolCallId, toolName: tool },
      recoverable: false,
    });
  }
  const self = port.member(context.sessionId);
  if (!self) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${tool} was called from a session that is not a team member`,
      { context: { toolCallId: context.toolCallId, toolName: tool }, recoverable: false },
    );
  }
  return { port, self };
}

const createMemberHandler: ToolHandler = async (input, context) => {
  const parsed = TeamCreateMemberInputSchema.parse(input) as TeamCreateMemberInput;
  const { port, self } = requireTeamMember(context, TEAM_CREATE_MEMBER_TOOL_NAME);

  const existing = port.members().find((member) => member.name === parsed.name);
  if (existing) {
    // 组建期重跑时最常见的动作：人已经在编，只差「负责哪块」。
    // 这时报「重名」会让主管换名字再招一个，团队就被招脏了。
    if (parsed.module === undefined && parsed.purpose === undefined) {
      return fail(
        `团队里已经有「${parsed.name}」。要补它的模块，重复调用 CreateTeammate 并带上 module；要换人换名字。`,
      );
    }
    const updated = guard(() =>
      port.updateMember?.({
        bySessionId: context.sessionId,
        name: parsed.name,
        ...(parsed.module === undefined ? {} : { module: parsed.module }),
        ...(parsed.purpose === undefined ? {} : { purpose: parsed.purpose }),
      }),
    );
    if (updated === undefined) {
      return fail(`当前端口不支持补职责，${parsed.name} 保持原样`);
    }
    if (isToolHandlerFailure(updated)) return updated;
    return {
      message: `已更新 ${updated.name} 的职责：${updated.module || "（模块未设）"}。`,
      memberId: updated.id,
      name: updated.name,
      role: updated.role,
    };
  }

  const verdict = canHire({
    role: self.role,
    depth: self.depth,
    memberCount: port.members().length,
    targetRole: parsed.role,
    limits: port.limits(),
  });
  if (!verdict.ok) return fail(verdict.reason);

  const member = guard(() =>
    port.createMember({
      bySessionId: context.sessionId,
      name: parsed.name,
      role: parsed.role,
      purpose: parsed.purpose,
      ...(parsed.module === undefined ? {} : { module: parsed.module }),
    }),
  );
  if (isToolHandlerFailure(member)) return member;
  const scope = member.module ? `，负责「${member.module}」` : "";
  return {
    message: `已招入 ${member.name}（${roleLabel(member.role)}）${scope}。派活用 MessageTeammate，收件人写名字。`,
    memberId: member.id,
    name: member.name,
    role: member.role,
  };
};

const messageHandler: ToolHandler = async (input, context) => {
  const parsed = TeamMessageInputSchema.parse(input) as TeamMessageInput;
  const { port, self } = requireTeamMember(context, TEAM_MESSAGE_TOOL_NAME);

  const target = port.members().find((member) => member.name === parsed.to);
  if (!target) {
    const names = port.members().map((member) => member.name).join("、");
    return fail(`没有叫「${parsed.to}」的成员。现有成员：${names}`);
  }
  if (target.id === self.id) return fail("不要给自己发消息");

  if (parsed.kind === "task") {
    const verdict = canAssign(self.role, target.role);
    if (!verdict.ok) return fail(verdict.reason);
  }

  if (parsed.kind === "reject") {
    // 退回的判据是「对方有已提交的产出、且没退到上限」，与组织层级无关——
    // 测试不是后端的上级，但必须能退它的货。
    const submitted = port
      .tasks()
      .filter((task) => task.ownerId === target.id && task.state !== "open")
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!submitted) return fail(`${target.name} 没有已提交的产出可退回`);
    const verdict = canReject({ revision: submitted.revision, limits: port.limits() });
    if (!verdict.ok) return fail(verdict.reason);
  }

  const message = sendOrFail(port, {
    fromSessionId: context.sessionId,
    to: parsed.to,
    kind: parsed.kind,
    content: parsed.content,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
    ...(parsed.refs === undefined ? {} : { refs: parsed.refs }),
    ...(parsed.awaitReply === undefined ? {} : { awaitReply: parsed.awaitReply }),
    ...(parsed.timeoutSec === undefined ? {} : { timeoutSec: parsed.timeoutSec }),
  });
  if (isToolHandlerFailure(message)) return message;

  const waiting = parsed.awaitReply === true;
  return {
    message: waiting
      ? `已发给 ${target.name}。本轮结束后你会挂起，对方回复时重新叫醒你。`
      : `已发给 ${target.name}。`,
    messageId: message.id,
    to: target.name,
    kind: message.kind,
    awaitingReply: waiting,
  };
};

const submitHandler: ToolHandler = async (input, context) => {
  const parsed = TeamSubmitInputSchema.parse(input) as TeamSubmitInput;
  const { port, self } = requireTeamMember(context, TEAM_SUBMIT_TOOL_NAME);

  const mine = port.tasks().filter((task) => task.ownerId === self.id);
  const task =
    parsed.taskId === undefined
      ? mine.filter((candidate) => candidate.state === "open").at(-1)
      : mine.find((candidate) => candidate.id === parsed.taskId);

  if (!task) {
    return fail(
      parsed.taskId === undefined
        ? "你手上没有未完成的任务；没有任务就不用提交"
        : `找不到属于你的任务 ${parsed.taskId}`,
    );
  }

  const verdict = canSubmit(task.state);
  if (!verdict.ok) return fail(verdict.reason);

  const submitted = guard(() =>
    port.submit({
      fromSessionId: context.sessionId,
      taskId: task.id,
      result: parsed.result,
      state: parsed.state,
    }),
  );
  if (isToolHandlerFailure(submitted)) return submitted;
  return {
    message:
      parsed.state === "done"
        ? `已提交「${task.title}」。等验收，不要重复提交。若还没有记录本次任务的要点，先用 SaveMemory 写 3–5 条。`
        : `已标记失败：「${task.title}」。上级会看到原因。若这次失败有值得记住的坑，用 SaveMemory 记下来。`,
    taskId: submitted.id,
    state: submitted.state,
  };
};

const saveMemoryHandler: ToolHandler = async (input, context) => {
  const parsed = TeamSaveMemoryInputSchema.parse(input) as TeamSaveMemoryInput;
  const content = parsed.content.trim();
  if (content.length === 0) return fail("记忆内容不能为空。");
  const { port } = requireTeamMember(context, TEAM_SAVE_MEMORY_TOOL_NAME);
  const saveMemory = port.saveMemory;
  if (!saveMemory) {
    return fail("当前端口不支持保存记忆。先把要点留在提交结果里，交给上级处理。");
  }

  guard(() =>
    saveMemory({
      fromSessionId: context.sessionId,
      kind: parsed.kind,
      content,
    }),
  );

  const label = parsed.kind === "task" ? "任务要点" : "模块知识";
  return {
    message: `已记住（${label}）。下一轮叫醒时它会作为背景资料出现，不需要你复述。`,
    kind: parsed.kind,
    chars: content.length,
  };
};

const deliverHandler: ToolHandler = async (input, context) => {
  const parsed = TeamDeliverInputSchema.parse(input) as TeamDeliverInput;
  const { port, self } = requireTeamMember(context, TEAM_DELIVER_TOOL_NAME);

  const verdict = canDeliver(self.role);
  if (!verdict.ok) return fail(verdict.reason);

  const delivered = guard(() => {
    port.deliver({ fromSessionId: context.sessionId, content: parsed.content });
    return true as const;
  });
  if (typeof delivered !== "boolean") return delivered;
  return { message: "已交付给用户。团队本次交付结束。", delivered: true };
};

const startHandler: ToolHandler = async (input, context) => {
  const parsed = TeamStartInputSchema.parse(input) as TeamStartInput;
  const port = context.teamPort;
  if (!port?.start) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Team start port is not configured for ${TEAM_START_TOOL_NAME}`,
      { context: { toolCallId: context.toolCallId, toolName: TEAM_START_TOOL_NAME }, recoverable: false },
    );
  }

  const result = await port.start({
    sessionId: context.sessionId,
    mode: parsed.mode,
    ...(parsed.requirement === undefined ? {} : { requirement: parsed.requirement }),
    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
  });

  if (!result.ok) return fail(result.summary);
  return { message: result.summary, ok: true };
};

// -----------------------------------------------
// 声明（四个工具共用同一套预算 / 超时 / 取消 / 跟踪策略）
// -----------------------------------------------
const PATTERN_SOURCES: ToolPermissionPatternSource[] = ["toolName"];

const COMMON_PERMISSION = {
  riskLevel: "low" as const,
  sideEffectScope: "session" as const,
  needsApproval: false,
  patternSources: PATTERN_SOURCES,
  alwaysAllowPatternSources: PATTERN_SOURCES,
  denyPriority: "beforeAsk" as const,
};

const TEAM_TIMEOUT = {
  kind: "timed" as const,
  defaultMs: 10_000,
  maxMs: 30_000,
  allowCallOverride: false,
};

const TEAM_CANCELLATION = {
  supported: true,
  cleanup: "none",
  userVisibleMessage: "the team tool call was cancelled",
} as const;

const TEAM_TRACE = {
  required: true,
  propagateToAdapters: true,
  recordInput: "summary",
  recordOutput: "summary",
} as const;

const TEAM_BUDGET = { maxInlineBytes: 4_000, maxModelBytes: 4_000, strategy: "truncate" as const };

/** 四个工具的输出都是「一句话 + 若干 id」。模型只需要那句话。 */
const TEAM_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: true,
};

function formatTeamModelContent(output: unknown): string {
  if (typeof output === "object" && output !== null && "message" in output) {
    const message = (output as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "ok";
}

export const teamCreateMemberToolEntry: ToolEntry = {
  capability: "Hire a teammate into the running team",
  metadata: {
    name: TEAM_CREATE_MEMBER_TOOL_NAME,
    searchHint: "hire teammate add team member",
    description: [
      "# CreateTeammate",
      "",
      "Hires one member into this team. The post outlives the task: a member you hire can be woken later by anyone who messages it.",
      "",
      "Always pass `module`: the directories, files or responsibility boundary this member owns. It is what keeps two people off the same files, and it is what the member reads every time it wakes up. Two members must not own overlapping paths.",
      "",
      "Hire only when you can name the work this post will own. A team of idle specialists costs tokens and adds no decisions.",
      "",
      "Roles and what each may do: supervisor (hire pm/ui/lead, ask the user), pm (plan), ui (prototype), lead (hire and assign fe/be/qa), fe/be/qa (do the work, ask others, cannot assign).",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: createMemberHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamCreateMemberInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamCreateMemberInputSchema,
  permission: { permission: "team.create_member", reason: "hires a teammate", ...COMMON_PERMISSION },
  resultBudget: TEAM_BUDGET,
  timeout: TEAM_TIMEOUT,
  cancellation: TEAM_CANCELLATION,
  trace: TEAM_TRACE,
};

export const teamMessageToolEntry: ToolEntry = {
  capability: "Send a message to a teammate",
  metadata: {
    name: TEAM_MESSAGE_TOOL_NAME,
    searchHint: "message teammate ask assign delegate",
    description: [
      "# MessageTeammate",
      "",
      "Sends a message to a teammate by name. This is the only way to reach another member — your plain text output is not visible to them.",
      "",
      "kinds: `task` assigns work (only to posts you may assign); `question` asks for a decision or a fact; `answer`/`result` reports back; `reject` returns a submitted deliverable that fails its acceptance criteria.",
      "",
      "Set `awaitReply: true` when you cannot continue without the answer: this turn ends, you are marked waiting, and you are woken with their reply. Do not block by looping.",
      "",
      "Always put paths, ids and error text in `refs` or `content`. The recipient sees only this message, not your conversation.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: messageHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamMessageInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamMessageInputSchema,
  permission: { permission: "team.message", reason: "messages a teammate", ...COMMON_PERMISSION },
  resultBudget: TEAM_BUDGET,
  timeout: TEAM_TIMEOUT,
  cancellation: TEAM_CANCELLATION,
  trace: TEAM_TRACE,
};

export const teamSubmitToolEntry: ToolEntry = {
  capability: "Submit or fail the task you own",
  metadata: {
    name: TEAM_SUBMIT_TOOL_NAME,
    searchHint: "submit task finish report result",
    description: [
      "# SubmitTask",
      "",
      "Submits the work you own. Nothing downstream moves until you call this — the person who assigned it is waiting on exactly this signal.",
      "",
      "`result` must say what you produced, where it is, and how it was verified. 'Done' without evidence will be rejected by whoever checks it.",
      "",
      "Before you submit, call `SaveMemory` with 3-5 key points you summarized yourself: what changed, decisions, pitfalls, verification, follow-ups. That memory is private to you and appears as background context on later wakes; the next task starts from it, not from this conversation.",
      "",
      "Do not paste the full result or transcript into `SaveMemory`; it is a short index, not an archive.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: submitHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamSubmitInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamSubmitInputSchema,
  permission: { permission: "team.submit", reason: "submits a team task", ...COMMON_PERMISSION },
  resultBudget: TEAM_BUDGET,
  timeout: TEAM_TIMEOUT,
  cancellation: TEAM_CANCELLATION,
  trace: TEAM_TRACE,
};

export const teamSaveMemoryToolEntry: ToolEntry = {
  capability: "Save a short note into the member's own long-term memory",
  metadata: {
    name: TEAM_SAVE_MEMORY_TOOL_NAME,
    searchHint: "remember memory note summary save knowledge",
    description: [
      "# SaveMemory",
      "",
      "Saves a short note into your own long-term memory. It is private to you: teammates never see it.",
      "",
      "Call it before you submit a task, with 3-5 key points you summarized yourself: what changed, decisions, pitfalls, verification, follow-ups. Call it when you learn a durable module convention, interface fact or environment pitfall.",
      "",
      "Memory appears as background context on later wakes. Treat it as possibly stale and verify against the workspace before acting. Do not paste full task results, logs or transcripts, and do not edit the memory file directly.",
      "",
      "`kind`: `task` (default) = this task's key points; `knowledge` = reusable module, interface or environment knowledge.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: saveMemoryHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamSaveMemoryInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamSaveMemoryInputSchema,
  permission: {
    permission: "team.save_memory",
    reason: "saves the member's own memory",
    ...COMMON_PERMISSION,
  },
  resultBudget: TEAM_BUDGET,
  timeout: TEAM_TIMEOUT,
  cancellation: TEAM_CANCELLATION,
  trace: TEAM_TRACE,
};

export const teamDeliverToolEntry: ToolEntry = {
  capability: "Deliver the team's final result to the user",
  metadata: {
    name: TEAM_DELIVER_TOOL_NAME,
    searchHint: "deliver final answer to user",
    description: [
      "# DeliverResult",
      "",
      "Supervisor only. Ends this team delivery and shows the text to the user.",
      "",
      "End with a short section listing the decisions you made on the user's behalf and what you assumed. The user was not watching every step; that section is how they audit you.",
      "",
      "Before delivering, call `SaveMemory` if this delivery leaves decisions or handoff points that future-you needs on the next requirement.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 4_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: deliverHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamDeliverInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamDeliverInputSchema,
  permission: { permission: "team.deliver", reason: "delivers to the user", ...COMMON_PERMISSION },
  resultBudget: TEAM_BUDGET,
  timeout: TEAM_TIMEOUT,
  cancellation: TEAM_CANCELLATION,
  trace: TEAM_TRACE,
};

export const teamStartToolEntry: ToolEntry = {
  capability: "Staff the team from this project, or hand it one requirement",
  metadata: {
    name: TEAM_START_TOOL_NAME,
    searchHint: "team build roster staff project delegate end to end",
    description: [
      "# StartTeam",
      "",
      "Two modes. Pick by what the user asked for.",
      "",
      "## mode=init — build the team",
      "The supervisor surveys this project (structure, entry points, existing code), decides the module split, hires one owner per module with `CreateTeammate` (module = the files/directories that member owns), and reports the roster.",
      "Use it when the user creates or initialises a team, or says the team should be staffed for this project.",
      "",
      "## mode=deliver — hand over one requirement",
      "The already-staffed team plans, designs, builds and verifies one requirement, then the supervisor delivers.",
      "The requirement must be self-contained: the team does not see this conversation.",
      "Use it when the work needs several roles end to end rather than one focused edit.",
      "",
      "Both modes block until the supervisor finishes that phase. Members are separate sessions; the user can open each one and read what it did.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: 8_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: startHandler,
  formatModelContent: formatTeamModelContent,
  inputSchema: TeamStartInputJsonSchema,
  outputSchema: TEAM_OUTPUT_SCHEMA,
  runtimeInputSchema: TeamStartInputSchema,
  permission: { permission: "team.start", reason: "starts a team delivery", ...COMMON_PERMISSION },
  resultBudget: { maxInlineBytes: 8_000, maxModelBytes: 8_000, strategy: "truncate" as const },
  // 一次团队交付可能跑很久（多个角色、多个回合）。不给固定超时：真正的逃生舱是取消。
  timeout: { kind: "none" as const },
  cancellation: {
    supported: true,
    cleanup: "bestEffort" as const,
    userVisibleMessage: "the team delivery was cancelled",
  },
  trace: TEAM_TRACE,
};

export const teamToolEntries: readonly ToolEntry[] = [
  teamCreateMemberToolEntry,
  teamMessageToolEntry,
  teamSubmitToolEntry,
  teamSaveMemoryToolEntry,
  teamDeliverToolEntry,
];

// 注册门要按名字分流（成员工具 vs 发起工具），名字常量与 contracts 单点同源。
export { TEAM_START_TOOL_NAME };

/** 成员工具：只有团队成员会话可见。 */
export const TEAM_MEMBER_TOOL_NAMES: ReadonlySet<string> = new Set(
  teamToolEntries.map((entry) => entry.metadata.name),
);

/** 发起工具：只有发起会话（主会话）可见。 */
export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...TEAM_MEMBER_TOOL_NAMES,
  teamStartToolEntry.metadata.name,
]);
