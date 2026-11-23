import { useCallback, useMemo, useState, type ReactNode } from "react";
import { buildTeamDeliveryPrompt, buildTeamStaffingPrompt } from "@zcode/shared";
import { UsersIcon, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import type { TeamSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  TEAM_ROLE_INITIAL,
  TEAM_ROLE_LABEL,
  formatTeamClock as clock,
  formatTeamDuration as duration,
} from "@/app-shell/teamArchitectureModel.js";
import { useTeamSnapshot } from "@/app-shell/useTeamSnapshot.js";

/**
 * 团队面板。
 *
 * 结构照 docs/team/team-panel-mockup.html：
 *   身份区（谁、什么状态、走到哪一步）→ 组织（真树）→ 任务（短名 + 原文）→ 协作（一行摘要）。
 *
 * 两条来自实拍的教训：
 *   1. 任务标题不能是提示词原文，否则列表全是「你是组长，负责…」；
 *   2. running 必须同时给出「在做什么 + 多久」，否则「卡住」和「在写代码」看起来一样。
 */

const PHASES: Array<{ key: string; label: string }> = [
  { key: "plan", label: "规划" },
  { key: "design", label: "设计" },
  { key: "build", label: "实施" },
  { key: "verify", label: "验收" },
];

const ROLE_CHIP = TEAM_ROLE_LABEL;
const ROLE_INITIAL = TEAM_ROLE_INITIAL;

const AVATAR_CLASS: Record<string, string> = {
  supervisor: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  lead: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  fe: "bg-emerald-500/12 text-emerald-300 border-emerald-500/35",
  be: "bg-emerald-500/12 text-emerald-300 border-emerald-500/35",
  qa: "bg-emerald-500/12 text-emerald-300 border-emerald-500/35",
};

const KIND_LABEL: Record<string, string> = {
  task: "派活",
  result: "提交",
  question: "提问",
  answer: "回答",
  reject: "退回",
  system: "系统",
};

const KIND_CLASS: Record<string, string> = {
  task: "text-sky-300 bg-sky-500/12",
  result: "text-emerald-300 bg-emerald-500/12",
  reject: "text-red-300 bg-red-500/12",
  question: "text-amber-300 bg-amber-500/12",
  answer: "text-amber-300 bg-amber-500/12",
  system: "text-muted-foreground bg-muted",
};

function firstLine(text: string, max = 90): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? text;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function TeamSidePane({
  tab,
  onCreateTask,
  onOpenSession,
  onOpenArchitecture,
}: {
  tab: TeamSidePaneTab;
  onCreateTask?: (request: { initialPrompt: string; autoSend?: boolean }) => void;
  /** 点成员 → 打开它自己的工作会话（成员本来就是一条独立会话）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 切到架构图：侧栏放不下组织关系，那是另一屏的事。 */
  onOpenArchitecture?: () => void;
}) {
  const { zcodeAgentService } = useServices();
  const { snapshot, error, now, reload: load } = useTeamSnapshot(tab.workspacePath);
  const [teamName, setTeamName] = useState("");
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);

  const createTeam = useCallback(async () => {
    const name = teamName.trim() || "交付小队";
    if (busy) return;
    setBusy(true);
    try {
      await zcodeAgentService.writeTeamConfig({ workspacePath: tab.workspacePath, name });
      await load();
    } catch (caught) {
      // 建团队失败要说给用户听：写 `.zcode/team.json` 可能被权限或磁盘状态挡住。
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, load, tab.workspacePath, teamName, zcodeAgentService]);

  const dispatch = useCallback(() => {
    const text = requirement.trim();
    if (!text) return;
    onCreateTask?.({ initialPrompt: buildTeamDeliveryPrompt(text), autoSend: true });
  }, [onCreateTask, requirement]);

  // 快照每 2 秒换一次引用；这里再派生一次是为了让下面 useMemo 的依赖在渲染之间保持稳定。
  const members = useMemo(() => snapshot?.members ?? [], [snapshot]);
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);
  const messages = useMemo(() => snapshot?.messages ?? [], [snapshot]);
  const openTasks = tasks.filter((task) => task.state === "open");
  const running = members.filter((member) => member.status === "running").length;

  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof members>();
    for (const member of members) {
      const key = member.parentId ?? "root";
      map.set(key, [...(map.get(key) ?? []), member]);
    }
    return map;
  }, [members]);

  const currentPhaseIndex = PHASES.findIndex((phase) => phase.key === snapshot?.phase);
  const statusPill = !snapshot?.started
    ? { text: "待命", className: "bg-muted text-muted-foreground border-border" }
    : snapshot.teamPhase === "staffing"
      ? { text: "组建中", className: "bg-violet-500/14 text-violet-300 border-violet-500/30" }
      : running > 0
      ? {
          text: openTasks.length > 0 ? "进行中" : "收尾中",
          className: "bg-emerald-500/14 text-emerald-300 border-emerald-500/30",
        }
      : snapshot.delivery
        ? { text: "已交付", className: "bg-sky-500/14 text-sky-300 border-sky-500/30" }
        : { text: "停滞", className: "bg-amber-500/14 text-amber-300 border-amber-500/30" };

  const describeMember = (member: (typeof members)[number]): string => {
    if (member.status === "running" && member.runningSince !== undefined) {
      return `已运行 ${duration(now - member.runningSince)}`;
    }
    if (member.status === "waiting") return "等回复";
    if (member.status === "failed") return "失败";
    // 「有未完成任务」不等于「在排队」：交付被中断（到时间上限或停滞退出）后调度器已经不在，
    // 这些人不会再被叫醒。两种情况分开说，否则用户会一直等一个不会开始的任务。
    if (member.currentTaskTitle) return running > 0 ? "排队中" : "停滞";
    return "空闲";
  };

  const renderTree = (parentId: string, depth: number): ReactNode =>
    (childrenByParent.get(parentId) ?? []).map((member) => {
      const active = member.status === "running";
      const waiting = member.status === "waiting" || member.status === "failed";
      const showChip = member.name !== ROLE_CHIP[member.role];
      return (
        <div key={member.id} className="relative">
          <div
            role={onOpenSession ? "button" : undefined}
            tabIndex={onOpenSession ? 0 : undefined}
            onClick={onOpenSession ? () => onOpenSession(member.sessionId) : undefined}
            onKeyDown={
              onOpenSession
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenSession(member.sessionId);
                    }
                  }
                : undefined
            }
            className={`flex items-center gap-2 rounded-md py-1 pr-2 hover:bg-accent/30 ${
              onOpenSession ? "cursor-pointer" : ""
            }`}
            style={{ paddingLeft: `${depth * 20 + 4}px` }}
            title={onOpenSession ? `${member.purpose}｜点击打开它的会话` : member.purpose}
          >
            {depth > 0 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 border-l border-border/60"
                style={{ left: `${depth * 20 - 8}px` }}
              />
            ) : null}
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-md border text-[11px] font-semibold ${
                AVATAR_CLASS[member.role] ?? "bg-muted text-muted-foreground border-border"
              }`}
            >
              {ROLE_INITIAL[member.role] ?? member.name.slice(0, 1)}
            </span>
            <span className="truncate text-ui-sm font-medium text-foreground">{member.name}</span>
            {showChip ? (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                {ROLE_CHIP[member.role] ?? member.role}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {describeMember(member)}
            </span>
            {onOpenSession ? (
              <span aria-hidden className="shrink-0 text-[11px] text-muted-foreground/50">
                ›
              </span>
            ) : null}
          </div>
          {member.module || member.currentTaskTitle ? (
            <div
              className="flex items-center gap-1.5 pr-2 pb-0.5 text-[11.5px] text-muted-foreground"
              style={{ paddingLeft: `${depth * 20 + 34}px` }}
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  active ? "bg-emerald-500" : waiting ? "bg-amber-500" : "bg-muted-foreground/40"
                }`}
              />
              <span className="truncate">
                {member.module ? `负责 ${member.module}` : "未划分模块"}
                {member.currentTaskTitle ? ` · ${member.currentTaskTitle}` : ""}
              </span>
            </div>
          ) : null}
          {renderTree(member.id, depth + 1)}
        </div>
      );
    });

  if (error && !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-ui-sm font-medium text-foreground">读不到团队状态</div>
        <div className="max-w-xs break-all text-ui-xs text-muted-foreground">{error}</div>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  if (!snapshot) {
    return <div className="p-6 text-ui-sm text-muted-foreground">读取中…</div>;
  }

  if (!snapshot.configured) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex w-full max-w-xs flex-col items-center gap-4 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            <UsersIcon className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <div className="text-ui-base font-semibold text-foreground">建一个团队</div>
            <div className="text-ui-sm leading-relaxed text-muted-foreground">
              把一整件事交给它：主管拆需求、招人、盯进度，最后把结果交回来。
            </div>
          </div>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-ui-sm outline-none placeholder:text-muted-foreground/70 focus:border-foreground/40"
            placeholder="给团队起个名字，例如：设置页改造"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createTeam();
            }}
          />
          <Button className="w-full" onClick={() => void createTeam()} disabled={busy}>
            {busy ? "正在创建…" : "创建团队"}
          </Button>
          {actionError ? (
            <div className="w-full text-left text-ui-xs leading-relaxed break-all text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const dispatchBar = (
    <div className="shrink-0 border-t border-border/60 p-3">
      <textarea
        className="min-h-[56px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-ui-sm outline-none placeholder:text-muted-foreground/70 focus:border-foreground/40"
        placeholder="要它交付什么？一句话说清结果即可"
        value={requirement}
        onChange={(event) => setRequirement(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            dispatch();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-ui-xs text-muted-foreground">
          {onCreateTask
            ? "打开新任务并填好指令，按回车即开始"
            : "当前环境无法直接派任务"}
        </span>
        <Button size="sm" onClick={dispatch} disabled={!requirement.trim() || !onCreateTask}>
          派任务
        </Button>
      </div>
    </div>
  );

  if (!snapshot.started) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            <UsersIcon className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <div className="text-ui-base font-semibold text-foreground">
            组建「{snapshot.teamName ?? "团队"}」
          </div>
          <div className="max-w-xs text-ui-sm leading-relaxed text-muted-foreground">
            主管会先读这个项目：把它拆成互不重叠的模块，再为每个模块招一个负责人。
            组建好之后，你派的任务会直接落到对的人手上。
          </div>
          {onCreateTask ? (
            <>
              <Button
                className="w-full max-w-xs"
                onClick={() =>
                  onCreateTask({ initialPrompt: buildTeamStaffingPrompt(), autoSend: true })
                }
              >
                开始组建
              </Button>
              <div className="text-ui-xs text-muted-foreground">
                会打开一个新任务，指令已填好——按回车，主管就开始读项目招人了。
              </div>
            </>
          ) : (
            <div className="text-ui-xs text-muted-foreground">在会话里发送 /team 即可开始组建</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui-sm font-semibold text-foreground">
            {snapshot.teamName ?? "团队"}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${statusPill.className}`}
          >
            {statusPill.text}
          </span>
          {onOpenArchitecture ? (
            <button
              type="button"
              onClick={onOpenArchitecture}
              title="打开架构图：看汇报关系、每人状态与记忆"
              aria-label="打开架构图"
              className="grid size-5 shrink-0 place-items-center rounded text-foreground-subtlest hover:bg-hover hover:text-foreground-subtle"
            >
              <Waypoints className="size-3.5" />
            </button>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {members.length} 人
            {openTasks.length > 0 ? ` · 进行中 ${openTasks.length}` : ""}
          </span>
        </div>
        {snapshot.goal ? (
          <div className="mt-1 line-clamp-2 text-ui-xs leading-relaxed text-muted-foreground">
            目标：{snapshot.goal}
          </div>
        ) : null}
        <div className="mt-2 flex gap-1">
          {PHASES.map((phase, index) => {
            const done = currentPhaseIndex >= 0 && index < currentPhaseIndex;
            const active = index === currentPhaseIndex;
            return (
              <div
                key={phase.key}
                className={`flex-1 rounded border py-1 text-center text-[11px] ${
                  active
                    ? "border-sky-500/35 bg-sky-500/14 text-sky-300"
                    : done
                      ? "border-transparent bg-muted text-muted-foreground"
                      : "border-transparent bg-muted/60 text-muted-foreground/70"
                }`}
              >
                {phase.label}
                {done ? " ✓" : ""}
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
          组织{" "}
          <span className="normal-case tracking-normal">
            · {members.length} 人{onOpenSession ? " · 点成员看它的会话" : ""}
          </span>
        </div>
        {members.length === 0 ? (
          <div className="px-2 py-1 text-ui-xs text-muted-foreground">还没有人</div>
        ) : (
          renderTree("root", 0)
        )}

        <div className="mt-3 px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
          任务 <span className="normal-case tracking-normal">· {openTasks.length} 进行中</span>
        </div>
        {tasks.length === 0 ? (
          <div className="px-2 py-1 text-ui-xs text-muted-foreground">还没有任务</div>
        ) : (
          tasks.slice(0, 14).map((task) => {
            const expanded = expandedTaskId === task.id;
            return (
              <div key={task.id} className="rounded-md hover:bg-accent/30">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
                  onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                      task.state === "done"
                        ? "bg-emerald-500/60"
                        : task.state === "failed"
                          ? "bg-red-500"
                          : "bg-amber-500"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-ui-sm ${
                        task.state === "done" ? "text-muted-foreground" : "text-foreground"
                      }`}
                    >
                      {task.title}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {task.ownerName} ·{" "}
                      {task.state === "done" ? "已完成" : task.state === "failed" ? "失败" : "进行中"}
                      {task.revision > 0 ? ` · 退回 ${task.revision} 次` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">
                    {expanded ? "收起" : "原文"}
                  </span>
                </button>
                {expanded ? (
                  <div className="mx-2 mb-2 rounded bg-muted/60 p-2 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                    {task.brief ?? "（这条任务没有保存原文）"}
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        <div className="mt-3 px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
          协作{" "}
          <span className="normal-case tracking-normal">
            · 最近 {Math.min(messages.length, 40)} 条
          </span>
        </div>
        {messages.length === 0 ? (
          <div className="px-2 py-1 text-ui-xs text-muted-foreground">还没有消息</div>
        ) : (
          messages.slice(-40).map((message) => {
            const expanded = expandedMessageId === message.id;
            return (
              <button
                key={message.id}
                type="button"
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/30"
                onClick={() => setExpandedMessageId(expanded ? null : message.id)}
              >
                <span
                  className={`mt-0.5 shrink-0 rounded px-1 text-[10px] leading-4 ${
                    KIND_CLASS[message.kind] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {KIND_LABEL[message.kind] ?? message.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="truncate">
                      {message.fromName} → {message.toName}
                    </span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {clock(message.createdAt)}
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 block text-ui-sm text-foreground/90 ${
                      expanded ? "break-words whitespace-pre-wrap" : "truncate"
                    }`}
                  >
                    {expanded ? message.content : firstLine(message.content)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {dispatchBar}
    </div>
  );
}
