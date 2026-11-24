// ============================================================
// Team architecture — 版面与记忆解析（纯函数，无 React）
// ============================================================
// 图是**汇报关系树**，不是流程图：一列一个层级，父子之间一条连线。
// 布局用 tidy tree 的简化版：叶子按顺序取列号，父节点居中于首尾子节点。
// 把它独立出来的原因是这些规则可以在没有 DOM 的地方被直接检查和复用。

import type { ZCodeTeamMemberView, ZCodeTeamSnapshot, ZCodeTeamTaskView } from "@zcode/services";

export const NODE_WIDTH = 196;
export const NODE_HEIGHT = 76;
const COL_GAP = 24;
const ROW_GAP = 76;
const PADDING = 20;

/** 角色徽章与头像字。放在这里是因为架构图和侧栏都要用同一套词，各写一份迟早不一致。 */
export const TEAM_ROLE_LABEL: Record<string, string> = {
  supervisor: "统筹",
  pm: "规划",
  ui: "设计",
  lead: "实施",
  fe: "页面",
  be: "存储",
  qa: "验收",
};

export const TEAM_ROLE_INITIAL: Record<string, string> = {
  supervisor: "主",
  pm: "产",
  ui: "设",
  lead: "组",
  fe: "前",
  be: "后",
  qa: "测",
};

export function teamRoleLabel(role: string): string {
  return TEAM_ROLE_LABEL[role] ?? role;
}

/**
 * 节点卡上只放模块的末段。`packages/ui/src/settings` 在 196px 宽的卡里只会剩下
 * 「负责 packages/ui/s…」，等于没信息；完整路径在详情面板里给。
 */
export function shortModuleName(module: string): string {
  const trimmed = module.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] || trimmed;
}

export function teamRoleInitial(member: ZCodeTeamMemberView): string {
  return TEAM_ROLE_INITIAL[member.role] ?? member.name.slice(0, 1);
}

/** 成员在界面上的可见状态。只有这五种，多一种就扫不动了。 */
export type TeamArchitectureStatus = "running" | "waiting" | "failed" | "delivered" | "idle";

export interface TeamArchitectureStatusMeta {
  label: string;
  /** 状态点。 */
  dot: string;
  /** 文字色。 */
  text: string;
  /** 胶囊底色（配合 text 使用）。 */
  surface: string;
  /** 连线颜色，直接用语义变量，SVG stroke 不做 Tailwind 映射。 */
  edge: string;
  /** 运行中节点的外描边。 */
  glow: string;
}

export const ARCH_STATUS_META: Record<TeamArchitectureStatus, TeamArchitectureStatusMeta> = {
  running: {
    label: "执行中",
    dot: "bg-success",
    text: "text-success",
    surface: "border-success/35 bg-success-surface text-success-surface-foreground",
    edge: "var(--color-success)",
    glow: "shadow-[0_0_0_3px_var(--color-success-surface)]",
  },
  waiting: {
    label: "等待他人",
    dot: "bg-warning",
    text: "text-warning",
    surface: "border-warning/35 bg-warning-surface text-warning-surface-foreground",
    edge: "var(--color-warning)",
    glow: "shadow-[0_0_0_3px_var(--color-warning-surface)]",
  },
  failed: {
    label: "已中断",
    dot: "bg-destructive",
    text: "text-destructive",
    surface: "border-destructive/35 bg-destructive-surface text-destructive-surface-foreground",
    edge: "var(--color-destructive)",
    glow: "",
  },
  delivered: {
    label: "已交付",
    dot: "bg-foreground-subtle",
    text: "text-foreground-subtle",
    surface: "border-border bg-muted text-foreground-subtle",
    edge: "var(--color-border)",
    glow: "",
  },
  idle: {
    label: "待命",
    dot: "bg-foreground-subtlest",
    text: "text-foreground-subtlest",
    surface: "border-border bg-surface text-foreground-subtle",
    edge: "var(--color-border)",
    glow: "",
  },
};

/**
 * 一个成员此刻的状态。
 * 「有未完成任务但没在跑」不算执行中——那是排队或停滞，不能和「正在写代码」长得一样。
 */
export function resolveMemberStatus(
  member: ZCodeTeamMemberView,
  tasks: ZCodeTeamTaskView[],
): TeamArchitectureStatus {
  if (member.status === "running") return "running";
  if (member.status === "waiting") return "waiting";
  if (member.status === "failed") return "failed";
  const finished = tasks.some((task) => task.ownerId === member.id && task.state === "done");
  return finished ? "delivered" : "idle";
}

export interface TeamArchitectureNode {
  member: ZCodeTeamMemberView;
  /** 左上角坐标。 */
  x: number;
  y: number;
  depth: number;
}

export interface TeamArchitectureEdge {
  id: string;
  fromId: string;
  toId: string;
  /** SVG path 的 d。 */
  d: string;
}

export interface TeamArchitectureLayout {
  nodes: TeamArchitectureNode[];
  edges: TeamArchitectureEdge[];
  width: number;
  height: number;
}

const EMPTY_LAYOUT: TeamArchitectureLayout = { nodes: [], edges: [], width: 0, height: 0 };

export function layoutTeamArchitecture(members: ZCodeTeamMemberView[]): TeamArchitectureLayout {
  if (members.length === 0) return EMPTY_LAYOUT;

  const byId = new Map(members.map((member) => [member.id, member]));

  // 父指针先过一遍环检测：数据损坏时宁可把这个节点当根，也不要递归到栈溢出。
  const parentOf = new Map<string, string | null>();
  for (const member of members) {
    let parent = member.parentId && byId.has(member.parentId) ? member.parentId : null;
    let cursor = parent;
    let hops = 0;
    while (cursor && hops <= members.length) {
      if (cursor === member.id) {
        parent = null;
        break;
      }
      cursor = byId.get(cursor)?.parentId ?? null;
      hops += 1;
    }
    parentOf.set(member.id, parent);
  }

  const childrenOf = new Map<string, ZCodeTeamMemberView[]>();
  const roots: ZCodeTeamMemberView[] = [];
  for (const member of members) {
    const parent = parentOf.get(member.id) ?? null;
    if (parent) {
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(member);
      else childrenOf.set(parent, [member]);
    } else {
      roots.push(member);
    }
  }

  const colOf = new Map<string, number>();
  let nextLeafCol = 0;

  const assignColumn = (member: ZCodeTeamMemberView): number => {
    const [firstKid, ...restKids] = childrenOf.get(member.id) ?? [];
    if (!firstKid) {
      const col = nextLeafCol;
      nextLeafCol += 1;
      colOf.set(member.id, col);
      return col;
    }
    const first = assignColumn(firstKid);
    for (const kid of restKids) assignColumn(kid);
    const lastKid = restKids.at(-1) ?? firstKid;
    const lastCol = colOf.get(lastKid.id) ?? first;
    const col = (first + lastCol) / 2;
    colOf.set(member.id, col);
    return col;
  };

  for (const root of roots) assignColumn(root);

  const depthOf = new Map<string, number>();
  const resolveDepth = (id: string): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    const parent = parentOf.get(id) ?? null;
    const depth = parent === null ? 0 : resolveDepth(parent) + 1;
    depthOf.set(id, depth);
    return depth;
  };

  const nodes: TeamArchitectureNode[] = members.map((member) => {
    const depth = resolveDepth(member.id);
    const col = colOf.get(member.id) ?? 0;
    return {
      member,
      x: PADDING + col * (NODE_WIDTH + COL_GAP),
      y: PADDING + depth * (NODE_HEIGHT + ROW_GAP),
      depth,
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.member.id, node]));
  const edges: TeamArchitectureEdge[] = [];
  for (const node of nodes) {
    const parentId = parentOf.get(node.member.id) ?? null;
    if (!parentId) continue;
    const parentNode = nodeById.get(parentId);
    if (!parentNode) continue;
    const fromX = parentNode.x + NODE_WIDTH / 2;
    const fromY = parentNode.y + NODE_HEIGHT;
    const toX = node.x + NODE_WIDTH / 2;
    const toY = node.y;
    const midY = fromY + (toY - fromY) / 2;
    edges.push({
      id: `${parentId}->${node.member.id}`,
      fromId: parentId,
      toId: node.member.id,
      d: `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`,
    });
  }

  const width = Math.max(...nodes.map((node) => node.x + NODE_WIDTH)) + PADDING;
  const height = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) + PADDING;
  return { nodes, edges, width, height };
}

// ------------------------------------------------------------
// 记忆解析
// ------------------------------------------------------------

export interface TeamMemoryEntry {
  id: string;
  /** 原样的 `MM-DD HH:MM`，不重新格式化——不同年份的记忆不该被假装成今年。 */
  time: string;
  text: string;
}

export interface ParsedTeamMemory {
  entries: TeamMemoryEntry[];
  notes: string[];
}

/** 模板自带的说明是写给模型的提示，不是用户的记录，展示出来只会挤占视线。 */
const TEMPLATE_LINES = ["这个文件只属于你", "可以用编辑工具追加到这里", "用 SaveMemory 追加新要点"];

const ENTRY_PATTERN = /^-\s*\[(\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*(.*)$/;

export function parseTeamMemory(text: string): ParsedTeamMemory {
  const entries: TeamMemoryEntry[] = [];
  const notes: string[] = [];
  let pendingNote: string[] = [];

  const flushNote = () => {
    if (pendingNote.length === 0) return;
    notes.push(pendingNote.join("\n"));
    pendingNote = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushNote();
      continue;
    }
    if (line.startsWith("#")) continue;
    if (TEMPLATE_LINES.some((fragment) => line.includes(fragment))) continue;

    const matched = ENTRY_PATTERN.exec(line);
    if (matched) {
      flushNote();
      const [, time, body] = matched;
      entries.push({ id: `${entries.length}-${time ?? ""}`, time: time ?? "", text: body ?? "" });
      continue;
    }
    pendingNote.push(line);
  }
  flushNote();

  return { entries, notes };
}

// ------------------------------------------------------------
// 展示用的小工具
// ------------------------------------------------------------

export function formatTeamDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "不到 1 分";
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function formatTeamClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 团队整体状态胶囊。「进行中」与「停滞」必须分开：两者在成员列表里都可能显示为 idle，
 * 但对用户意味着完全不同的下一步（继续等 / 去处理）。
 */
export function resolveTeamPill(snapshot: ZCodeTeamSnapshot | undefined): {
  label: string;
  className: string;
} {
  if (!snapshot?.started) {
    return { label: "待命", className: "border-border bg-surface text-foreground-subtle" };
  }
  const running = snapshot.members.filter((member) => member.status === "running").length;
  const openTasks = snapshot.tasks.filter((task) => task.state === "open").length;
  if (snapshot.teamPhase === "staffing") {
    return {
      label: "组建中",
      className: "border-warning/35 bg-warning-surface text-warning-surface-foreground",
    };
  }
  if (running > 0) {
    return {
      label: openTasks > 0 ? "进行中" : "收尾中",
      className: "border-success/35 bg-success-surface text-success-surface-foreground",
    };
  }
  if (snapshot.delivery) {
    return { label: "已交付", className: "border-border bg-surface text-foreground-subtle" };
  }
  return {
    label: "停滞",
    className: "border-warning/35 bg-warning-surface text-warning-surface-foreground",
  };
}
