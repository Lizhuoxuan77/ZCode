// ============================================================
// Team Agent Port
// ============================================================
// 团队 agent 与「父调用子、子返回即销毁」的子代理是两件事：
//   - 子代理是**一次调用**，团队 agent 是**一个岗位**。岗位活过单个任务，干完回到 idle 等下一件事。
//   - 子代理之间不能说话，团队 agent 之间必须能（后端要问前端接口怎么定）。
//
// 所以这里只暴露「状态」和「投递」两组动作，不暴露「等待」或「唤醒」——
// 唤醒是调度器的事：工具写完邮箱就返回，调度器下一圈自己会发现有人可跑。
// 把唤醒放进工具，等于把调度逻辑撒进几十个调用点。

import type { SessionId } from "./shared.js";

/**
 * 业务流被拒绝（模型可读、可改道），与真正的故障分开。
 * 工具层捕获它并转成 ToolHandlerFailure：模型看到「该怎么办」，而不是一段栈。
 */
export class TeamFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamFlowError";
  }
}

/** 团队角色。与 subagent 的 agentType 无关：角色决定权限，能力由工具面决定。 */
export type TeamRole = "supervisor" | "pm" | "ui" | "lead" | "fe" | "be" | "qa";

/**
 * 一次团队运行的两种意图。
 * - `init`：组建期。还没有任务，主管的活是「看清楚这个项目需要哪些模块、每个模块谁负责」。
 * - `deliver`：交付期。团队已经在位，主管的活是拆阶段、派活、验收。
 */
export type TeamStartMode = "init" | "deliver";

/**
 * 成员状态。**没有 done**：任务会结束，人不会。
 * 混进 done，团队就只能干一票，干完全散——而「员工随时能被同事叫起来答疑」是本功能的硬要求。
 */
export type TeamMemberStatus = "idle" | "running" | "waiting" | "failed" | "archived";

/** 消息种类。reject 是下游退回上游的产出，与 error 不同：被退回的任务仍然 open。 */
export type TeamMessageKind = "task" | "result" | "question" | "answer" | "system" | "reject";

/** 任务单状态。与成员状态分开：这是唯一能收敛的维度。 */
export type TeamTaskState = "open" | "done" | "failed";

export interface TeamMemberRef {
  id: string;
  /** 派活与提问都用名字寻址，模型不必记 tm_xxx 这种 id。 */
  name: string;
  role: TeamRole;
  /** null = 主管，全队唯一。 */
  parentId: string | null;
  depth: number;
  status: TeamMemberStatus;
  /** 该成员的持久会话。transcript 就在这个会话里，重启后原样还在。 */
  sessionId: SessionId;
  purpose: string;
  /**
   * 这个成员独占的模块/范围（目录、文件、职责边界）。空串表示还没划分。
   * 它有两个用途：派活时不再靠猜谁该做什么；成员换任务时也不会越界改别人的东西。
   */
  module: string;
}

export interface TeamMessageRef {
  id: string;
  from: string;
  to: string;
  kind: TeamMessageKind;
  content: string;
  refs: readonly string[];
  createdAt: number;
}

export interface TeamTaskRef {
  id: string;
  ownerId: string;
  title: string;
  state: TeamTaskState;
  /** 被打回次数。达到上限后必须升级，否则上下游会互相打回无限循环。 */
  revision: number;
  result?: string;
  createdAt: number;
}

export interface TeamCreateMemberRequest {
  /** 调用者的会话 id。身份与权限都从它推导，模型无法伪造。 */
  bySessionId: SessionId;
  name: string;
  role: TeamRole;
  purpose: string;
  /** 它独占的模块/范围。组建期必须给：这是「每人一块」落到数据上的地方。 */
  module?: string;
}

/** 组建期补职责：给已经在编的成员补上模块边界，而不是再招一个重名的。 */
export interface TeamUpdateMemberRequest {
  bySessionId: SessionId;
  name: string;
  module?: string;
  purpose?: string;
}

export interface TeamSendMessageRequest {
  fromSessionId: SessionId;
  /** 成员名或会话 id。 */
  to: string;
  kind: TeamMessageKind;
  content: string;
  /** 任务短名：列表与面板显示它，content 仍是完整指令。 */
  title?: string;
  /** 交付阶段，驱动面板的阶段条。 */
  phase?: "plan" | "design" | "build" | "verify";
  refs?: readonly string[];
  /** true = 发送者本轮结束后进入 waiting，等对方回复再被唤醒。 */
  awaitReply?: boolean;
  timeoutSec?: number;
}

export interface TeamSubmitRequest {
  fromSessionId: SessionId;
  /** 省略时取该成员手上唯一未完成的任务。 */
  taskId?: string;
  result: string;
  state: Exclude<TeamTaskState, "open">;
}

export interface TeamLimits {  /** 全队人数上限（含主管）。 */
  maxMembers: number;
  /** 组织树最大深度。主管 depth=0。 */
  maxDepth: number;
  /** 单次打回上限。到顶必须升级。 */
  maxRevisions: number;
  /** 问答链跳数上限。 */
  maxQuestionHops: number;
}

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxDepth: 3,
  maxRevisions: 1,
  maxQuestionHops: 3,
};

export interface TeamStartResult {
  ok: boolean;
  /** 主管的交付内容（ok=true）或失败/中止原因。 */
  summary: string;
  /** 本次交付里每个成员的产出，供调用方投影。 */
  deliveries?: readonly { name: string; role: TeamRole; result: string }[];
}

export interface TeamPort {
  /** 会话 → 成员。主会话不是成员，返回 undefined。 */
  member(sessionId: SessionId): TeamMemberRef | undefined;
  members(): readonly TeamMemberRef[];
  tasks(): readonly TeamTaskRef[];
  limits(): TeamLimits;
  createMember(input: TeamCreateMemberRequest): TeamMemberRef;
  /** 补/改职责与模块。只有主管或它自己的上级能改。 */
  updateMember?(input: TeamUpdateMemberRequest): TeamMemberRef;
  send(input: TeamSendMessageRequest): TeamMessageRef;
  submit(input: TeamSubmitRequest): TeamTaskRef;
  /** 只有主管能交付：写进主会话，并收尾根任务（否则调度器会认为还有活没人干）。 */
  deliver(input: { fromSessionId: SessionId; content: string }): void;
  /**
   * 由发起会话启动团队。两种模式：
   * - `init`：组建期——主管先看项目、按模块把人招齐，然后交付一份编制说明；
   * - `deliver`：派一票活给已经组建好的团队，等它收敛。
   * 只在发起会话的 runtime 上注入——团队成员没有这个能力，否则谁都能另起一个团队。
   */
  start?(input: {
    sessionId: SessionId;
    mode: TeamStartMode;
    /** `deliver` 模式必填；`init` 模式会被忽略（组建期没有具体需求）。 */
    requirement?: string;
    signal?: AbortSignal;
  }): Promise<TeamStartResult>;
}
