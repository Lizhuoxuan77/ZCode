// ============================================================
// Team snapshot — 给界面看的只读投影
// ============================================================
// 团队状态写在 ZCode 用户数据目录（默认 `.zcode/cli/teams/<slug>-<hash>/team.db`，
// agent 进程独占写），不再写进用户项目。渲染进程读不到它，
// 所以这里提供一个**纯读**投影：一次打开、几条 SELECT、立刻关掉。
//
// 三条约束：
//   1. **只读连接**（readOnly）。界面永远不改团队状态；写入只有一条路——通过主管的消息。
//   2. **WAL 下可并发读**。agent 正在跑的时候也要能看，因此不加任何写锁。
//   3. **不缓存**。轮询就是轮询：每个请求都读盘，避免界面看到一份过期快照还以为是实时。

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeTeamConfig, type TeamConfigView } from "@zcode/shared";
import { isRemoteTeamWorkspace, resolveDesktopTeamStorage } from "./teamStorage.js";

export interface ZCodeTeamSnapshotParams {
  workspacePath: string;
  /** 远程身份优先于路径；用于定位同一个工作区的团队数据。 */
  workspaceIdentity?: string;
  /** 消息流保留条数，默认 60。界面折叠着看够用。 */
  messageLimit?: number;
}

export interface ZCodeTeamMemberView {
  id: string;
  name: string;
  /** 角色名直接来自 team.db；界面按字符串兜底，不反向依赖 CLI 的团队契约类型。 */
  role: string;
  status: string;
  depth: number;
  parentId: string | null;
  purpose: string;
  sessionId: string;
  /** 这个成员独占的模块（目录/职责）；空串表示还没划分。 */
  module: string;
  /** 正在跑的这一轮开始时间；没有在跑就是 undefined。界面用来显示「已运行 12 分」。 */
  runningSince?: number;
  /** 手上第一个未完成任务（短名），用作「当前动作」。 */
  currentTaskTitle?: string;
}

export interface ZCodeTeamTaskView {
  id: string;
  /** 短名（列表用），不是提示词原文。 */
  title: string;
  /** 完整指令，面板点「原文」时展示。 */
  brief?: string;
  phase?: string;
  state: string;
  revision: number;
  ownerId: string;
  ownerName: string;
  result?: string;
}

export interface ZCodeTeamMessageView {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  kind: string;
  content: string;
  createdAt: number;
}

export interface ZCodeTeamSnapshot {
  /** 用户数据目录里有没有团队配置——决定团队功能是否开启。 */
  configured: boolean;
  /** 配置里写的团队名。界面用来标身份，缺失时退回「团队」。 */
  teamName?: string;
  /** 当前团队配置（已归一化，含默认值）。供面板配置表单读初值。 */
  config?: TeamConfigView;
  /** 有没有已经跑过的团队（db 存在）。 */
  started: boolean;
  goal?: string;
  delivery?: string;
  members: ZCodeTeamMemberView[];
  tasks: ZCodeTeamTaskView[];
  messages: ZCodeTeamMessageView[];
  /** 团队当前所处阶段：staffing（组建中）/ ready（待命）。 */
  teamPhase?: string;
  /** 当前所处的交付阶段（由未完成任务的 phase 归纳）。 */
  phase?: string;
  /** 这次读取的时刻，界面用来判断轮询是否还在推进。 */
  readAt: number;
}

const EMPTY = (configured: boolean): ZCodeTeamSnapshot => ({
  configured,
  started: false,
  members: [],
  tasks: [],
  messages: [],
  readAt: Date.now(),
});

interface MemberRow {
  id: string;
  name: string;
  role: string;
  purpose: string;
  parent_id: string | null;
  depth: number;
  status: string;
  session_id: string;
  module: string | null;
}

interface TaskRow {
  id: string;
  owner_id: string;
  title: string;
  brief: string | null;
  phase: string | null;
  state: string;
  revision: number;
  result: string | null;
}

interface MessageRow {
  id: string;
  from_id: string;
  to_id: string;
  kind: string;
  content: string;
  created_at: number;
}

/**
 * 读一次团队状态。任何异常都降级成「空快照 + started=false」：
 * 界面在团队还没建、库正在迁移、或 agent 刚退出时都不该炸掉。
 */
/** 读整份团队配置；坏文件按不存在处理，团队功能不该因为一个逗号起不来。 */
function readTeamConfig(configPath: string): TeamConfigView | undefined {
  try {
    return normalizeTeamConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function readTeamSnapshot(params: ZCodeTeamSnapshotParams): ZCodeTeamSnapshot {
  // 远程工作区的团队数据在远端机器的用户目录里，桌面端读不到，也不该在这里假装读过。
  if (isRemoteTeamWorkspace(params)) return EMPTY(false);
  const storage = resolveDesktopTeamStorage(params);
  const configPath = storage.configPath;
  const configured = existsSync(configPath);
  const config = readTeamConfig(configPath);
  const teamName = config?.name;
  const configFields = config ? { config } : {};
  const dbPath = storage.databasePath;
  if (!existsSync(dbPath)) {
    return { ...EMPTY(configured), ...(teamName ? { teamName } : {}), ...configFields };
  }

  const limit = Math.min(Math.max(params.messageLimit ?? 60, 1), 500);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const members = db
      .prepare(
        "SELECT id, name, role, purpose, parent_id, depth, status, session_id, module FROM team_member ORDER BY created_at",
      )
      .all() as unknown as MemberRow[];
    if (members.length === 0) {
      return { ...EMPTY(configured), ...(teamName ? { teamName } : {}), ...configFields, readAt: Date.now() };
    }

    const nameById = new Map(members.map((member) => [member.id, member.name]));
    const tasks = db
      .prepare(
        "SELECT id, owner_id, title, brief, phase, state, revision, result FROM team_task ORDER BY created_at DESC",
      )
      .all() as unknown as TaskRow[];
    const messages = db
      .prepare(
        "SELECT id, from_id, to_id, kind, content, created_at FROM team_message ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as unknown as MessageRow[];
    const activeTurns = db
      .prepare("SELECT member_id, started_at FROM team_turn WHERE ended_at IS NULL")
      .all() as unknown as Array<{ member_id: string; started_at: number }>;
    const runningSince = new Map(activeTurns.map((row) => [row.member_id, row.started_at]));
    const metaRows = db.prepare("SELECT key, value FROM team_meta").all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));

    return {
      configured,
      ...(teamName ? { teamName } : {}),
      ...configFields,
      started: true,
      ...(meta.get("goal") === undefined ? {} : { goal: meta.get("goal") }),
      // staffing = 主管正在看项目配人；ready = 编制已定，可以派任务。
      ...(meta.get("phase") === undefined ? {} : { teamPhase: meta.get("phase") }),
      ...(meta.get("delivery") === undefined ? {} : { delivery: meta.get("delivery") }),
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        role: member.role,
        status: member.status,
        depth: member.depth,
        parentId: member.parent_id,
        purpose: member.purpose,
        sessionId: member.session_id,
        module: member.module ?? "",
        ...(runningSince.has(member.id) ? { runningSince: runningSince.get(member.id) } : {}),
        ...(() => {
          // 取最早的一条未完成任务当作「当前动作」：那是它手上最先要交的东西。
          const open = tasks.filter((task) => task.owner_id === member.id && task.state === "open");
          const current = open.at(-1);
          return current ? { currentTaskTitle: current.title } : {};
        })(),
      })),
      // 阶段：未完成任务里最常见的那个；都完成了就用最近一条。
      ...(() => {
        const openPhases = tasks.filter((task) => task.state === "open" && task.phase);
        const source = openPhases.length > 0 ? openPhases : tasks.filter((task) => task.phase);
        return source[0]?.phase ? { phase: source[0].phase } : {};
      })(),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        ...(task.brief === null ? {} : { brief: task.brief }),
        ...(task.phase === null ? {} : { phase: task.phase }),
        state: task.state,
        revision: task.revision,
        ownerId: task.owner_id,
        ownerName: nameById.get(task.owner_id) ?? task.owner_id,
        ...(task.result === null ? {} : { result: task.result }),
      })),
      // 库里按时间倒序取最近 N 条，展示顺序要正序。
      messages: messages.reverse().map((message) => ({
        id: message.id,
        from: message.from_id,
        fromName: nameById.get(message.from_id) ?? message.from_id,
        to: message.to_id,
        toName: nameById.get(message.to_id) ?? message.to_id,
        kind: message.kind,
        content: message.content,
        createdAt: message.created_at,
      })),
      readAt: Date.now(),
    };
  } catch {
    return { ...EMPTY(configured), ...configFields };
  } finally {
    db?.close();
  }
}
