// ============================================================
// Team Store — SQLite
// ============================================================
// 单一事实源。所有跨进程可见的东西都在这里：成员、邮箱、任务单、等待租约、交付。
// **没有内存缓存**——这不是洁癖：团队要在进程被 kill -9 之后接着跑，任何活在内存里的
// 状态都会在那时消失。
//
// 认领（claim）用 BEGIN IMMEDIATE 包住「取消息 + 标消费 + 置 running」三件事。
// 分三步做的话，崩溃会落在中间：消息被标了消费但没人跑，任务静默丢失。

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_TEAM_LIMITS,
  TeamFlowError,
  createSessionId,
  type SessionId,
  type TeamCreateMemberRequest,
  type TeamLimits,
  type TeamMemberRef,
  type TeamMemberStatus,
  type TeamMessageKind,
  type TeamMessageRef,
  type TeamPort,
  type TeamRole,
  type TeamSendMessageRequest,
  type TeamSubmitRequest,
  type TeamUpdateMemberRequest,
  type TeamTaskRef,
  type TeamTaskState,
} from "@zcode/contracts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS team_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_member (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT '',
  parent_id  TEXT,
  depth      INTEGER NOT NULL,
  status     TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  module     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_message (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL,
  to_id        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  refs_json    TEXT NOT NULL DEFAULT '[]',
  hop          INTEGER NOT NULL DEFAULT 0,
  await_reply  INTEGER NOT NULL DEFAULT 0,
  timeout_sec  INTEGER,
  consumed_at  INTEGER,
  turn_id      TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_message_inbox ON team_message(to_id, consumed_at);
CREATE TABLE IF NOT EXISTS team_task (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  assigned_by TEXT,
  title       TEXT NOT NULL,
  brief       TEXT,
  phase       TEXT,
  state       TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_owner ON team_task(owner_id, state);
CREATE TABLE IF NOT EXISTS team_wait (
  member_id    TEXT NOT NULL,
  on_member_id TEXT NOT NULL,
  started_at   INTEGER NOT NULL DEFAULT 0,
  deadline     INTEGER NOT NULL,
  PRIMARY KEY (member_id, on_member_id)
);
CREATE TABLE IF NOT EXISTS team_turn (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  outcome    TEXT,
  error      TEXT
);
`;

export interface TeamStoreOptions {
  file: string;
  now?: () => number;
  limits?: Partial<TeamLimits>;
  /** 测试用：给 id 一个确定的前缀来源。 */
  idPrefix?: string;
}

interface MemberRow {
  id: string;
  name: string;
  role: string;
  purpose: string;
  parent_id: string | null;
  depth: number;
  status: string;
  session_id: string;
  module: string;
  created_at: number;
}

interface MessageRow {
  id: string;
  from_id: string;
  to_id: string;
  kind: string;
  content: string;
  refs_json: string;
  hop: number;
  created_at: number;
}

interface TaskRow {
  id: string;
  owner_id: string;
  assigned_by: string | null;
  title: string;
  state: string;
  revision: number;
  result: string | null;
  created_at: number;
}

function toMember(row: MemberRow): TeamMemberRef {
  return {
    id: row.id,
    name: row.name,
    role: row.role as TeamRole,
    parentId: row.parent_id,
    depth: row.depth,
    status: row.status as TeamMemberStatus,
    sessionId: row.session_id as SessionId,
    purpose: row.purpose,
    module: row.module ?? "",
  };
}

function toMessage(row: MessageRow): TeamMessageRef {
  let refs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.refs_json);
    if (Array.isArray(parsed)) refs = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    refs = [];
  }
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    kind: row.kind as TeamMessageKind,
    content: row.content,
    refs,
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): TeamTaskRef {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    state: row.state as TeamTaskState,
    revision: row.revision,
    ...(row.result === null ? {} : { result: row.result }),
    createdAt: row.created_at,
  };
}

/** 一条要被投递的消息。store 只负责写，不负责叫醒——唤醒是调度器的事。 */
export interface ClaimedTurn {
  turnId: string;
  member: TeamMemberRef;
  messages: readonly TeamMessageRef[];
}

export class TeamStore implements TeamPort {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly limitValues: TeamLimits;
  private readonly prefix: string;

  constructor(options: TeamStoreOptions) {
    this.db = new DatabaseSync(options.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.now = options.now ?? Date.now;
    this.limitValues = { ...DEFAULT_TEAM_LIMITS, ...options.limits };
    this.prefix = options.idPrefix ?? "tm";
  }

  close(): void {
    this.db.close();
  }

  /**
   * 老库补列。团队库是就地演进的：用户已经有跑过任务的 db，
   * 不能要求他删库重来（那会丢掉整段交付记录）。
   */
  private migrate(): void {
    const memberColumns = new Set(
      (this.db.prepare("PRAGMA table_info(team_member)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!memberColumns.has("module")) {
      this.db.exec("ALTER TABLE team_member ADD COLUMN module TEXT NOT NULL DEFAULT ''");
    }

    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(team_task)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const column of ["brief", "phase"]) {
      if (!columns.has(column)) {
        this.db.exec(`ALTER TABLE team_task ADD COLUMN ${column} TEXT`);
      }
    }

    // 老任务把整段提示词塞在 title 里（界面上一屏全是「你是组长，负责…」）。
    // 就地回填：长标题压成短名，原文迁进 brief，不丢信息。
    const longTitles = this.db
      .prepare("SELECT id, title FROM team_task WHERE brief IS NULL AND length(title) > 30")
      .all() as unknown as Array<{ id: string; title: string }>;
    if (longTitles.length > 0) {
      const update = this.db.prepare("UPDATE team_task SET title = ?, brief = ? WHERE id = ?");
      for (const task of longTitles) update.run(deriveTaskTitle(task.title), task.title, task.id);
    }
  }

  private newId(kind: string): string {
    return `${this.prefix}_${kind}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------
  // 读面（TeamPort）
  // ---------------------------------------------

  limits(): TeamLimits {
    return this.limitValues;
  }

  member(sessionId: SessionId): TeamMemberRef | undefined {
    const row = this.db.prepare("SELECT * FROM team_member WHERE session_id = ?").get(sessionId) as
      | MemberRow
      | undefined;
    return row === undefined ? undefined : toMember(row);
  }

  memberById(id: string): TeamMemberRef | undefined {
    const row = this.db.prepare("SELECT * FROM team_member WHERE id = ?").get(id) as
      | MemberRow
      | undefined;
    return row === undefined ? undefined : toMember(row);
  }

  memberByName(name: string): TeamMemberRef | undefined {
    const row = this.db.prepare("SELECT * FROM team_member WHERE name = ?").get(name) as
      | MemberRow
      | undefined;
    return row === undefined ? undefined : toMember(row);
  }

  memberByRole(role: TeamRole): TeamMemberRef | undefined {
    const row = this.db
      .prepare("SELECT * FROM team_member WHERE role = ? ORDER BY created_at LIMIT 1")
      .get(role) as unknown as MemberRow | undefined;
    return row === undefined ? undefined : toMember(row);
  }

  waitCount(memberId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM team_wait WHERE member_id = ?")
      .get(memberId) as { n: number };
    return row.n;
  }

  hasWait(memberId: string): boolean {
    return this.waitCount(memberId) > 0;
  }

  /** 终止整次交付时清空租约：留着会让下一次发起误判「还有人在等」。 */
  clearWaits(): void {
    this.db.prepare("DELETE FROM team_wait").run();
  }

  hasWaiting(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM team_wait").get() as { n: number };
    return row.n > 0;
  }

  members(): readonly TeamMemberRef[] {
    return (this.db.prepare("SELECT * FROM team_member ORDER BY created_at").all() as unknown as MemberRow[]).map(
      toMember,
    );
  }

  tasks(): readonly TeamTaskRef[] {
    return (this.db.prepare("SELECT * FROM team_task ORDER BY created_at").all() as unknown as TaskRow[]).map(
      toTask,
    );
  }

  // ---------------------------------------------
  // 写面（TeamPort）
  // ---------------------------------------------

  createMember(input: TeamCreateMemberRequest): TeamMemberRef {
    const by = this.member(input.bySessionId);
    if (!by) throw new Error("createMember called from a non-member session");
    const id = this.newId("member");
    const sessionId = createSessionId(`team-${this.newId("sess")}`);
    this.db
      .prepare(
        `INSERT INTO team_member (id, name, role, purpose, parent_id, depth, status, session_id, module, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.role,
        input.purpose,
        by.id,
        by.depth + 1,
        sessionId,
        input.module?.trim() ?? "",
        this.now(),
      );
    return this.memberById(id)!;
  }

  /**
   * 补/改成员的模块与职责。老团队（v0.3 之前）里成员没有 module，
   * 重新组建时主管需要把边界补上；没有这条路，它只能招一个重名的，团队就会脏。
   */
  updateMember(input: TeamUpdateMemberRequest): TeamMemberRef {
    const by = this.member(input.bySessionId);
    if (!by) throw new Error("updateMember called from a non-member session");
    const target = this.memberByName(input.name);
    if (!target) throw new TeamFlowError(`团队里没有叫「${input.name}」的成员`);
    if (by.role !== "supervisor" && target.parentId !== by.id) {
      throw new TeamFlowError(`「${input.name}」不是你招的人，改职责要找它的上级`);
    }
    this.db
      .prepare("UPDATE team_member SET module = ?, purpose = ? WHERE id = ?")
      .run(
        input.module?.trim() ?? target.module,
        input.purpose?.trim() ?? target.purpose,
        target.id,
      );
    return this.memberById(target.id)!;
  }

  /** 团队启动时创建主管：没有上级，depth=0。 */
  createSupervisor(input: { name: string; role: TeamRole; purpose: string }): TeamMemberRef {
    const id = this.newId("member");
    const sessionId = createSessionId(`team-${this.newId("sess")}`);
    this.db
      .prepare(
        `INSERT INTO team_member (id, name, role, purpose, parent_id, depth, status, session_id, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, 'idle', ?, ?)`,
      )
      .run(id, input.name, input.role, input.purpose, sessionId, this.now());
    return this.memberById(id)!;
  }

  send(input: TeamSendMessageRequest): TeamMessageRef {
    const from = this.member(input.fromSessionId);
    if (!from) throw new Error("send called from a non-member session");
    const target = this.memberByName(input.to) ?? this.memberById(input.to);
    if (!target) throw new Error(`no teammate named ${input.to}`);

    return this.transaction(() => {
      const hop = input.kind === "question" ? this.nextHop(from.id) : 0;
      if (input.kind === "question" && hop > this.limitValues.maxQuestionHops) {
        // 踢皮球熔断：不再把问题转给下一个人，而是把球踢回给提问者并要求升级。
        this.enqueue({
          fromId: target.id,
          toId: from.id,
          kind: "system",
          content:
            `[熔断] 这条问答已转手 ${hop} 次，超过上限 ${this.limitValues.maxQuestionHops}。` +
            "不要再问下一个人：把已知信息整理后升级给你的上级。",
          refs: [],
        });
        throw new TeamFlowError(
          `问答链已 ${hop} 跳，超过 ${this.limitValues.maxQuestionHops} 跳上限；请升级给上级`,
        );
      }

      if (input.kind === "task") {
        this.insertTask({
          ownerId: target.id,
          assignedBy: from.id,
          // 标题是**给界面看的短名**：没有就用正文里的「工作包：xxx」，
          // 再退回首行截断。整段提示词留在 brief 里，面板点「原文」才看。
          title: input.title?.trim() || deriveTaskTitle(input.content),
          brief: input.content,
          ...(input.phase || inferTaskPhase(input.content)
            ? { phase: input.phase ?? inferTaskPhase(input.content) }
            : {}),
          state: "open",
          revision: 0,
        });
      }

      if (input.kind === "reject") {
        const submitted = this.db
          .prepare(
            `SELECT * FROM team_task WHERE owner_id = ? AND state != 'open'
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(target.id) as unknown as TaskRow | undefined;
        if (submitted === undefined) {
          throw new TeamFlowError(`${target.name} 没有已提交的产出可退回`);
        }
        // 上限在这里也拦一次：工具层已经拦过，但 store 是唯一事实源，
        // 任何绕过工具的调用路径都不该能把回退死循环打开。
        if (submitted.revision >= this.limitValues.maxRevisions) {
          throw new TeamFlowError(
            `已打回 ${submitted.revision} 次，达到上限；请升级给上级裁决`,
          );
        }
        this.db
          .prepare(
            `UPDATE team_task SET state = 'open', revision = revision + 1, updated_at = ? WHERE id = ?`,
          )
          .run(this.now(), submitted.id);
      }

      const message = this.enqueue({
        fromId: from.id,
        toId: target.id,
        kind: input.kind,
        content: input.content,
        refs: input.refs ?? [],
        hop,
      });

      // 一条回复就满足一次等待。按 (等待者, 回复者) 精确匹配，
      // 不能按「任意回复」清——组长同时等前后端，先回来的那个不该把他叫醒。
      if (input.kind === "answer" || input.kind === "result" || input.kind === "reject") {
        this.settleWait(target.id, from.id);
      }

      if (input.kind === "task" && from.id !== target.id) {
        this.db
          .prepare("UPDATE team_member SET status = 'idle' WHERE id = ? AND status = 'waiting'")
          .run(target.id);
      }

      if (input.awaitReply === true) {
        const timeoutSec = input.timeoutSec ?? 600;
        const startedAt = this.now();
        this.db
          .prepare(
            `INSERT INTO team_wait (member_id, on_member_id, started_at, deadline) VALUES (?, ?, ?, ?)
             ON CONFLICT(member_id, on_member_id) DO UPDATE SET
               started_at = excluded.started_at, deadline = excluded.deadline`,
          )
          .run(from.id, target.id, startedAt, startedAt + timeoutSec * 1000);
      }

      return toMessage({
        id: message.id,
        from_id: message.fromId,
        to_id: message.toId,
        kind: message.kind,
        content: message.content,
        refs_json: JSON.stringify(message.refs),
        hop: message.hop,
        created_at: message.createdAt,
      });
    });
  }

  submit(input: TeamSubmitRequest): TeamTaskRef {
    const owner = this.member(input.fromSessionId);
    if (!owner) throw new Error("submit called from a non-member session");
    return this.transaction(() => {
      const row =
        input.taskId === undefined
          ? (this.db
              .prepare(
                `SELECT * FROM team_task WHERE owner_id = ? AND state = 'open'
                 ORDER BY created_at DESC LIMIT 1`,
              )
              .get(owner.id) as unknown as TaskRow | undefined)
          : (this.db.prepare("SELECT * FROM team_task WHERE id = ?").get(input.taskId) as
              | TaskRow
              | undefined);
      if (row === undefined) throw new TeamFlowError("没有可提交的任务");
      if (row.state !== "open") throw new TeamFlowError("该任务已经结束，不能重复提交");

      this.db
        .prepare("UPDATE team_task SET state = ?, result = ?, updated_at = ? WHERE id = ?")
        .run(input.state, input.result, this.now(), row.id);

      if (row.assigned_by) {
        this.enqueue({
          fromId: owner.id,
          toId: row.assigned_by,
          kind: "result",
          content: `${owner.name} 提交「${row.title}」（${input.state}）：\n${input.result}`,
          refs: [row.id],
        });
        this.settleWait(row.assigned_by, owner.id);
        this.db
          .prepare("UPDATE team_member SET status = 'idle' WHERE id = ? AND status = 'waiting'")
          .run(row.assigned_by);
      }

      return toTask(
        this.db.prepare("SELECT * FROM team_task WHERE id = ?").get(row.id) as unknown as TaskRow,
      );
    });
  }

  deliver(input: { fromSessionId: SessionId; content: string }): void {
    const by = this.member(input.fromSessionId);
    if (!by) throw new Error("deliver called from a non-member session");
    this.transaction(() => {
      this.setMeta("delivery", input.content);
      this.setMeta("delivered_at", String(this.now()));
      // 组建期交付的是「编制」，交付完团队进入待命；这次交付不算项目产出。
      if (this.getMeta("phase") === "staffing") this.setMeta("phase", "ready");
      this.db
        .prepare(
          `UPDATE team_task SET state = 'done', updated_at = ?
           WHERE owner_id = ? AND state = 'open'`,
        )
        .run(this.now(), by.id);
    });
  }

  // ---------------------------------------------
  // 调度器用
  // ---------------------------------------------

  /** 有未消费消息的 idle 成员。这是唯一的「谁该跑」判据。 */
  readyMembers(limit: number): readonly TeamMemberRef[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM team_member m
         WHERE m.status = 'idle'
           AND EXISTS (SELECT 1 FROM team_message g WHERE g.to_id = m.id AND g.consumed_at IS NULL)
         ORDER BY m.created_at
         LIMIT ?`,
      )
      .all(limit) as unknown as MemberRow[];
    return rows.map(toMember);
  }

  /** 认领一轮：取消息、标消费、置 running、开 turn 行。四件事必须同时发生。 */
  claimTurn(member: TeamMemberRef): ClaimedTurn {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM team_message WHERE to_id = ? AND consumed_at IS NULL
           ORDER BY created_at LIMIT 50`,
        )
        .all(member.id) as unknown as MessageRow[];
      const turnId = this.newId("turn");
      const ts = this.now();
      const update = this.db.prepare(
        "UPDATE team_message SET consumed_at = ?, turn_id = ? WHERE id = ?",
      );
      for (const row of rows) update.run(ts, turnId, row.id);
      this.db.prepare("UPDATE team_member SET status = 'running' WHERE id = ?").run(member.id);
      this.db
        .prepare("INSERT INTO team_turn (id, member_id, started_at) VALUES (?, ?, ?)")
        .run(turnId, member.id, ts);
      return { turnId, member, messages: rows.map(toMessage) };
    });
  }

  finishTurn(input: {
    turnId: string;
    memberId: string;
    /** 这一轮里有没有发出过 awaitReply 的消息。 */
    awaitingReply: boolean;
    error?: string;
  }): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE team_turn SET ended_at = ?, outcome = ?, error = ? WHERE id = ?")
        .run(
          this.now(),
          input.error === undefined ? "ok" : "failed",
          input.error ?? null,
          input.turnId,
        );
      if (input.error !== undefined) {
        this.enqueue({
          fromId: input.memberId,
          toId: input.memberId,
          kind: "system",
          content: `[失败] 上一轮执行失败：${input.error}\n换一种做法；重复同样的调用只会再失败一次。`,
          refs: [],
        });
      }
      // 挂起的前提是收件箱已经空了：还有没读的消息却去等回复，
      // 那些消息就要等到超时之后才有人处理。
      const nextStatus: TeamMemberStatus =
        input.awaitingReply && !this.hasUnconsumed(input.memberId) ? "waiting" : "idle";
      this.db
        .prepare("UPDATE team_member SET status = ? WHERE id = ?")
        .run(nextStatus, input.memberId);
    });
  }

  /**
   * 主管接需求：根任务 + 一条 task 消息，两者同时落地。
   * 同时清掉上一次的交付标记——团队是**常驻**的，干完一票还要接下一票，
   * 不清就永远返回上一票的交付内容。
   */
  startRequirement(supervisorId: string, requirement: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM team_meta WHERE key IN ('delivery', 'delivered_at')").run();
      this.setMeta("goal", requirement);
      this.insertTask({
        ownerId: supervisorId,
        assignedBy: null,
        title: firstLine(requirement),
        brief: requirement,
        state: "open",
        revision: 0,
      });
      this.enqueue({
        fromId: supervisorId,
        toId: supervisorId,
        kind: "task",
        content: requirement,
        refs: [],
      });
    });
  }

  /**
   * 主管开始组建团队：根任务是「把这个项目拆成模块并配人」。
   * 与 startRequirement 的区别是意图：这里没有用户需求，主管的产出是编制本身。
   */
  beginStaffing(supervisorId: string, projectName: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM team_meta WHERE key IN ('delivery', 'delivered_at')").run();
      this.setMeta("phase", "staffing");
      this.setMeta("goal", `为项目「${projectName}」组建团队：确定模块划分与各模块负责人`);
      this.insertTask({
        ownerId: supervisorId,
        assignedBy: null,
        title: "组建团队",
        brief:
          "调查这个项目的结构与现有代码，把它拆成若干互不重叠的模块，为每个模块招一个负责人，最后报告编制。",
        state: "open",
        revision: 0,
      });
      this.enqueue({
        fromId: supervisorId,
        toId: supervisorId,
        kind: "task",
        content: "开始组建团队。",
        refs: [],
      });
    });
  }

  /** 调度器向某成员投一条系统消息（超时、继续、恢复）。来源不是任何成员。 */
  systemMessage(toId: string, content: string): void {
    this.enqueue({ fromId: toId, toId, kind: "system", content, refs: [] });
  }

  /** 这个团队现在处于哪个阶段：staffing / ready / 空。 */
  phase(): string | undefined {
    return this.getMeta("phase");
  }

  /**
   * 超时是一种**消息**，不是异常分支。等待方收到的是一段可行动的信息
   * （谁没回、等了多久、你可以重试或上报），而不是一个抛出来的错误。
   */
  expireWaits(): number {
    const now = this.now();
    const rows = this.db.prepare("SELECT * FROM team_wait WHERE deadline <= ?").all(now) as Array<{
      member_id: string;
      on_member_id: string;
      started_at: number;
      deadline: number;
    }>;
    for (const row of rows) {
      const waiter = this.memberById(row.member_id);
      const other = this.memberById(row.on_member_id);
      if (!waiter || !other) continue;
      const waitedSec = Math.max(1, Math.round((now - row.started_at) / 1000));
      this.transaction(() => {
        this.db
          .prepare("DELETE FROM team_wait WHERE member_id = ? AND on_member_id = ?")
          .run(row.member_id, row.on_member_id);
        this.enqueue({
          fromId: other.id,
          toId: waiter.id,
          kind: "system",
          content:
            `[超时] ${other.name} 在 ${waitedSec} 秒内没有回复你。\n` +
            "你可以：重发一次（附上更明确的输入）、换个人问、或者上报给你的上级。不要一直等。",
          refs: [],
        });
        const remaining = this.db
          .prepare("SELECT COUNT(*) AS n FROM team_wait WHERE member_id = ?")
          .get(waiter.id) as { n: number };
        if (remaining.n === 0) {
          this.db
            .prepare("UPDATE team_member SET status = 'idle' WHERE id = ? AND status = 'waiting'")
            .run(waiter.id);
        }
      });
    }
    return rows.length;
  }

  /**
   * 进程重启后，上一轮 claim 过的 turn 一定没有 ended_at。
   * 这些成员不能继续停在 running（没人会来交还），必须重新可跑并收到一条说明。
   */
  recoverDanglingTurns(): number {
    const rows = this.db
      .prepare("SELECT * FROM team_turn WHERE ended_at IS NULL")
      .all() as Array<{ id: string; member_id: string }>;
    for (const row of rows) {
      const member = this.memberById(row.member_id);
      if (!member) continue;
      this.transaction(() => {
        this.db
          .prepare("UPDATE team_turn SET ended_at = ?, outcome = 'recovered' WHERE id = ?")
          .run(this.now(), row.id);
        this.enqueue({
          fromId: member.id,
          toId: member.id,
          kind: "system",
          content:
            "[恢复] 进程在上一轮执行中途退出。已做的工作可能没有落盘：先检查现状（读文件、看任务），" +
            "再决定继续还是重做，不要假设上一轮成功了。",
          refs: [],
        });
        this.db
          .prepare("UPDATE team_member SET status = 'idle' WHERE id = ? AND status = 'running'")
          .run(member.id);
      });
    }
    return rows.length;
  }

  delivery(): string | undefined {
    return this.getMeta("delivery");
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO team_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM team_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** 停滞诊断：谁在等谁、谁手上有没做完的活。只用于失败时给人看。 */
  describeStall(): string {
    const members = this.members();
    const waits = this.db.prepare("SELECT * FROM team_wait").all() as Array<{
      member_id: string;
      on_member_id: string;
    }>;
    const open = this.tasks().filter((task) => task.state === "open");
    const lines = members.map((member) => {
      const waitingFor = waits
        .filter((wait) => wait.member_id === member.id)
        .map((wait) => this.memberById(wait.on_member_id)?.name ?? wait.on_member_id);
      const owned = open.filter((task) => task.ownerId === member.id).map((task) => task.title);
      return `- ${member.name}（${member.role}）${member.status}${
        waitingFor.length > 0 ? `，等 ${waitingFor.join("、")}` : ""
      }${owned.length > 0 ? `，未完成：${owned.join("；")}` : ""}`;
    });
    return lines.join("\n");
  }

  // ---------------------------------------------
  // 内部
  // ---------------------------------------------

  private enqueue(input: {
    fromId: string;
    toId: string;
    kind: TeamMessageKind;
    content: string;
    refs: readonly string[];
    hop?: number;
  }): { id: string; fromId: string; toId: string; kind: TeamMessageKind; content: string; refs: readonly string[]; hop: number; createdAt: number } {
    const id = this.newId("msg");
    const createdAt = this.now();
    const hop = input.hop ?? 0;
    this.db
      .prepare(
        `INSERT INTO team_message (id, from_id, to_id, kind, content, refs_json, hop, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.fromId, input.toId, input.kind, input.content, JSON.stringify(input.refs), hop, createdAt);
    return { id, fromId: input.fromId, toId: input.toId, kind: input.kind, content: input.content, refs: input.refs, hop, createdAt };
  }

  private insertTask(input: {
    ownerId: string;
    assignedBy: string | null;
    title: string;
    brief?: string;
    phase?: string;
    state: TeamTaskState;
    revision: number;
  }): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO team_task (id, owner_id, assigned_by, title, brief, phase, state, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.newId("task"),
        input.ownerId,
        input.assignedBy,
        input.title,
        input.brief ?? null,
        input.phase ?? null,
        input.state,
        input.revision,
        ts,
        ts,
      );
  }

  /** 问题转手次数：取这个提问者收到的最后一轮消息的 hop，再 +1。 */
  private nextHop(fromId: string): number {
    const row = this.db
      .prepare(
        `SELECT hop FROM team_message WHERE to_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(fromId) as { hop: number } | undefined;
    return (row?.hop ?? 0) + 1;
  }

  private hasUnconsumed(memberId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM team_message WHERE to_id = ? AND consumed_at IS NULL")
      .get(memberId) as { n: number };
    return row.n > 0;
  }

  private settleWait(waiterId: string, responderId: string): void {    const deleted = this.db
      .prepare("DELETE FROM team_wait WHERE member_id = ? AND on_member_id = ?")
      .run(waiterId, responderId);
    if (deleted.changes === 0) return;
    const remaining = this.db
      .prepare("SELECT COUNT(*) AS n FROM team_wait WHERE member_id = ?")
      .get(waiterId) as { n: number };
    if (remaining.n === 0) {
      this.db
        .prepare("UPDATE team_member SET status = 'idle' WHERE id = ? AND status = 'waiting'")
        .run(waiterId);
    }
  }
}

/** 业务流被拒绝（模型可读），与真正的故障分开。定义在 contracts，工具层要按类型捕获。 */
export { TeamFlowError };

/** 从派活正文里取一个能放在列表里的短名。 */
export function deriveTaskTitle(content: string): string {
  const workPackage = /工作包[:：]\s*([^\n（(]{2,40})/.exec(content);
  if (workPackage?.[1]) return workPackage[1].trim();
  // 「你是组长，负责「记账app」的【实施阶段】」→ 记账app · 实施
  const subject = /负责[「"]([^」"]{1,20})[」"]的?【([^】]{1,10})】/.exec(content);
  if (subject?.[1] && subject[2]) {
    return `${subject[1]} · ${subject[2].replace(/阶段$/, "")}`;
  }
  const stage = /【([^】]{2,12})】/.exec(content);
  const head = firstLine(content).replace(/^你是[^，,]{1,12}[，,]?/, "").trim();
  if (stage?.[1] && head.length > 18) return `${stage[1]}：${head.slice(0, 16)}`;
  return head.length > 24 ? `${head.slice(0, 23)}…` : head;
}

/** 阶段：优先看正文里的【xx阶段】，再看关键词。 */
export function inferTaskPhase(content: string): string | undefined {
  const explicit = /【([^】]{1,8}?阶段?)】/.exec(content)?.[1];
  if (explicit) {
    if (explicit.includes("规划")) return "plan";
    if (explicit.includes("设计")) return "design";
    if (explicit.includes("实施")) return "build";
    if (explicit.includes("验收") || explicit.includes("测试")) return "verify";
  }
  if (/规划方案|plan\.md/.test(content)) return "plan";
  if (/设计说明|页面设计|原型/.test(content)) return "design";
  if (/工作包|实现|编码/.test(content)) return "build";
  if (/验收|回归|测试/.test(content)) return "verify";
  return undefined;
}

function firstLine(content: string): string {
  const line = content.split("\n").find((candidate) => candidate.trim().length > 0) ?? content;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line.trim();
}
