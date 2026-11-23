import { useCallback, useEffect, useMemo, useState } from "react";
import { buildTeamDeliveryPrompt, buildTeamStaffingPrompt } from "@zcode/shared";
import type {
  ZCodeTeamMemberMemoryResult,
  ZCodeTeamMemberView,
  ZCodeTeamTaskView,
} from "@zcode/services";
import { ArrowUpRight, PanelRight, RefreshCw, Waypoints, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import {
  ARCH_STATUS_META,
  NODE_HEIGHT,
  NODE_WIDTH,
  formatTeamClock,
  formatTeamDuration,
  layoutTeamArchitecture,
  parseTeamMemory,
  resolveMemberStatus,
  resolveTeamPill,
  shortModuleName,
  teamRoleInitial,
  teamRoleLabel,
} from "@/app-shell/teamArchitectureModel.js";
import { useTeamSnapshot } from "@/app-shell/useTeamSnapshot.js";

/**
 * 团队架构图。
 *
 * 侧栏 320px 只放得下一行行的树，看不出「谁向谁汇报、谁在等谁」，所以组织单独给一屏：
 * 左边是汇报关系树，右边是被点开那个人的状态与记忆，底部一条派任务。
 *
 * 颜色只编码状态（执行中/等待/中断/已交付/待命），身份靠名字与层级——同一种绿不该
 * 既表示「这个角色是前端」又表示「它正在跑」。
 */

const MEMORY_POLL_INTERVAL_MS = 5_000;
const MEMORY_ENTRY_LIMIT = 40;

export interface TeamArchitectureViewProps {
  workspacePath: string;
  open: boolean;
  onClose: () => void;
  /** 切回右侧紧凑面板。 */
  onOpenCompactPane?: () => void;
  onCreateTask?: (request: { initialPrompt: string; autoSend?: boolean }) => void;
  /** 打开成员的会话（成员本身就是一条独立会话）。 */
  onOpenSession?: (sessionId: string) => void;
}

export function TeamArchitectureView({
  workspacePath,
  open,
  onClose,
  onOpenCompactPane,
  onCreateTask,
  onOpenSession,
}: TeamArchitectureViewProps) {
  const { snapshot, error, now } = useTeamSnapshot(workspacePath, { enabled: open });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requirement, setRequirement] = useState("");

  // 从快照派生成稳定引用：否则每次渲染都是新数组，下面所有 useMemo 的依赖都失效。
  const members = useMemo(() => snapshot?.members ?? [], [snapshot]);
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);

  const selectedMember = useMemo(
    () => members.find((member) => member.id === selectedId) ?? null,
    [members, selectedId],
  );

  // 成员被归档/重建后旧 id 会失效：清掉选中，否则右侧一直挂着一个不存在的名字。
  useEffect(() => {
    if (selectedId && members.length > 0 && !members.some((member) => member.id === selectedId)) {
      setSelectedId(null);
    }
  }, [members, selectedId]);

  const layout = useMemo(() => layoutTeamArchitecture(members), [members]);
  const pill = resolveTeamPill(snapshot);
  const openTasks = tasks.filter((task) => task.state === "open");
  const runningCount = members.filter((member) => member.status === "running").length;

  const neighborsOf = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const set = new Set<string>([selectedId]);
    for (const edge of layout.edges) {
      if (edge.fromId === selectedId) set.add(edge.toId);
      if (edge.toId === selectedId) set.add(edge.fromId);
    }
    return set;
  }, [layout.edges, selectedId]);

  const dispatch = useCallback(() => {
    const text = requirement.trim();
    if (!text || !onCreateTask) return;
    onCreateTask({ initialPrompt: buildTeamDeliveryPrompt(text), autoSend: true });
    setRequirement("");
    onClose();
  }, [onClose, onCreateTask, requirement]);

  const startStaffing = useCallback(() => {
    if (!onCreateTask) return;
    onCreateTask({ initialPrompt: buildTeamStaffingPrompt(), autoSend: true });
    onClose();
  }, [onCreateTask, onClose]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(900px,calc(100vh-48px))] w-[min(1320px,calc(100vw-48px))] max-w-[calc(100vw-48px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1320px]"
      >
        <DialogTitle className="sr-only">团队架构图</DialogTitle>
        <DialogDescription className="sr-only">
          团队的汇报关系、每个成员当前的状态，以及它们各自记住的东西。
        </DialogDescription>

        <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-ui-lg font-semibold text-foreground">
                {snapshot?.teamName ?? "团队"}
              </h2>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-ui-xs",
                  pill.className,
                )}
              >
                {pill.label}
              </span>
              <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
                {members.length} 人 · 进行中 {runningCount}
                {openTasks.length > 0 ? ` · 待办 ${openTasks.length}` : ""}
              </span>
            </div>
            {snapshot?.goal ? (
              <p className="mt-1 line-clamp-1 text-ui-xs text-foreground-subtle">
                目标 · {snapshot.goal}
              </p>
            ) : (
              <p className="mt-1 text-ui-xs text-foreground-subtlest">
                点一个人，看它现在在做什么、记住了什么
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center gap-3 lg:flex">
              {(["running", "waiting", "delivered", "failed", "idle"] as const).map((status) => (
                <span
                  key={status}
                  className="inline-flex items-center gap-1.5 text-ui-xs text-foreground-subtle"
                >
                  <span aria-hidden className={cn("size-1.5 rounded-full", ARCH_STATUS_META[status].dot)} />
                  {ARCH_STATUS_META[status].label}
                </span>
              ))}
            </div>
            {onOpenCompactPane ? (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-foreground-subtle"
                onClick={() => {
                  onOpenCompactPane();
                  onClose();
                }}
              >
                <PanelRight className="size-3.5" />
                紧凑面板
              </Button>
            ) : null}
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="关闭架构图">
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {!snapshot ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div className="space-y-1.5">
              <div className="text-ui-base font-medium text-foreground">读取团队状态…</div>
              <div className="text-ui-xs text-foreground-subtlest">
                {error ? "读不到团队状态，正在重试" : "正在打开这个项目的团队"}
              </div>
            </div>
          </div>
        ) : !snapshot.configured || !snapshot.started || members.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
              <div className="grid size-11 place-items-center rounded-xl border border-border bg-surface">
                <Waypoints className="size-5 text-foreground-subtle" aria-hidden />
              </div>
              <div className="space-y-1.5">
                <div className="text-ui-base font-semibold text-foreground">
                  {snapshot.configured ? "还没有组建团队" : "这个项目还没有团队"}
                </div>
                <div className="text-ui-sm leading-relaxed text-foreground-subtle">
                  {snapshot.configured
                    ? "主管会先读这个项目，把它拆成互不重叠的模块，再给每块配一个负责人。"
                    : "建一个团队，它会一直在这个项目里：谁负责哪块、谁在等谁，都会画在这张图上。"}
                </div>
              </div>
              {snapshot.configured && onCreateTask ? (
                <Button className="w-full max-w-xs" onClick={startStaffing}>
                  开始组建
                </Button>
              ) : onOpenCompactPane ? (
                <Button className="w-full max-w-xs" variant="outline" onClick={onOpenCompactPane}>
                  去创建团队
                </Button>
              ) : (
                <div className="text-ui-xs text-foreground-subtlest">在会话里发送 /team 即可开始</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div
              className="relative min-w-0 flex-1 overflow-auto bg-background"
              style={{
                backgroundImage:
                  "radial-gradient(color-mix(in oklab, var(--color-border) 70%, transparent) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
            >
              {/* 图比容器小时居中，比容器大时从左侧开始滚：mx-auto 在溢出时退化为 0，不会裁掉左缘。 */}
              <div className="flex min-h-full w-full items-center">
                <div
                  className="relative mx-auto"
                  style={{ width: layout.width, height: layout.height }}
                >
                <svg
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  width={layout.width}
                  height={layout.height}
                >
                  {layout.edges.map((edge) => {
                    const touched = neighborsOf.has(edge.fromId) && neighborsOf.has(edge.toId);
                    const target = members.find((member) => member.id === edge.toId);
                    const status = target ? resolveMemberStatus(target, tasks) : "idle";
                    const dim = selectedId !== null && !touched;
                    return (
                      <path
                        key={edge.id}
                        d={edge.d}
                        fill="none"
                        strokeLinecap="round"
                        stroke={touched ? ARCH_STATUS_META[status].edge : "var(--color-border)"}
                        strokeWidth={touched ? 1.75 : 1.25}
                        opacity={dim ? 0.35 : 1}
                      />
                    );
                  })}
                </svg>

                {layout.nodes.map((node) => {
                  const member = node.member;
                  const status = resolveMemberStatus(member, tasks);
                  const meta = ARCH_STATUS_META[status];
                  const selected = selectedId === member.id;
                  const dim = selectedId !== null && !neighborsOf.has(member.id);
                  const action =
                    status === "running"
                      ? (member.currentTaskTitle ?? "正在处理任务")
                      : status === "waiting"
                        ? "等同事回复"
                        : status === "failed"
                          ? "被中断，需要重新调度"
                          : status === "delivered"
                            ? `已完成 ${tasks.filter((task) => task.ownerId === member.id && task.state === "done").length} 项`
                            : "待命";
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => setSelectedId(selected ? null : member.id)}
                      aria-pressed={selected}
                      title={member.purpose}
                      className={cn(
                        "absolute flex flex-col rounded-xl border bg-card px-2.5 py-2 text-left transition-[border-color,box-shadow,opacity] duration-150",
                        selected
                          ? "border-primary/55 shadow-md"
                          : "border-border hover:border-border-hover hover:shadow-sm",
                        status === "running" && meta.glow,
                        dim && "opacity-70",
                      )}
                      style={{
                        left: node.x,
                        top: node.y,
                        width: NODE_WIDTH,
                        height: NODE_HEIGHT,
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border/70 bg-surface text-ui-xs font-semibold text-foreground-subtle">
                          {teamRoleInitial(member)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-ui-sm font-medium text-foreground">
                              {member.name}
                            </span>
                            <span className="shrink-0 rounded border border-border/70 px-1 text-ui-xs text-foreground-subtlest">
                              {teamRoleLabel(member.role)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-ui-xs text-foreground-subtlest">
                            {member.module ? `负责 ${shortModuleName(member.module)}` : "未划分模块"}
                          </span>
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            meta.dot,
                            status === "running" && "animate-pulse",
                          )}
                        />
                      </span>
                      <span className={cn("mt-auto truncate pt-1 text-ui-xs", meta.text)}>
                        {action}
                      </span>
                    </button>
                  );
                })}
                </div>
              </div>
            </div>

            <aside className="flex w-[344px] shrink-0 flex-col border-l border-border bg-popover max-lg:w-[300px]">
              {selectedMember ? (
                <MemberDetail
                  key={selectedMember.id}
                  member={selectedMember}
                  tasks={tasks}
                  workspacePath={workspacePath}
                  now={now}
                  {...(onOpenSession ? { onOpenSession } : {})}
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <div className="grid size-9 place-items-center rounded-lg border border-border bg-card">
                    <Waypoints className="size-4 text-foreground-subtlest" aria-hidden />
                  </div>
                  <div className="text-ui-sm font-medium text-foreground">选一个人</div>
                  <div className="text-ui-xs leading-relaxed text-foreground-subtlest">
                    左边每张卡都是团队里的一个成员。
                    <br />
                    点开看它的状态、在手任务和记忆。
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-5 py-2.5">
          <input
            className="h-8 min-w-0 flex-1 rounded-lg border border-input-border bg-background px-3 text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest focus:border-foreground/35"
            placeholder={
              onCreateTask ? "交给团队一件事：一句话说清结果，回车派发" : "当前环境无法直接派任务"
            }
            value={requirement}
            disabled={!onCreateTask}
            onChange={(event) => setRequirement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                dispatch();
              }
            }}
          />
          <Button size="sm" onClick={dispatch} disabled={!requirement.trim() || !onCreateTask}>
            派任务
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function MemberDetail({
  member,
  tasks,
  workspacePath,
  now,
  onOpenSession,
}: {
  member: ZCodeTeamMemberView;
  tasks: ZCodeTeamTaskView[];
  workspacePath: string;
  now: number;
  onOpenSession?: (sessionId: string) => void;
}) {
  const status = resolveMemberStatus(member, tasks);
  const meta = ARCH_STATUS_META[status];
  const ownTasks = tasks.filter((task) => task.ownerId === member.id).slice(0, 5);
  const statusText =
    status === "running" && member.runningSince !== undefined
      ? `已运行 ${formatTeamDuration(now - member.runningSince)}`
      : meta.label;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-ui-sm font-semibold text-foreground-subtle">
            {teamRoleInitial(member)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-ui-base font-semibold text-foreground">
                {member.name}
              </span>
              <span className="shrink-0 rounded border border-border/70 px-1 text-ui-xs text-foreground-subtlest">
                {teamRoleLabel(member.role)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
              <span className={cn("text-ui-xs", meta.text)}>{statusText}</span>
            </div>
          </div>
        </div>
        <dl className="mt-3 space-y-1.5">
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ui-xs text-foreground-subtlest">模块</dt>
            <dd className="min-w-0 flex-1 break-all text-ui-sm text-foreground-subtle">
              {member.module || "未划分"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-10 shrink-0 text-ui-xs text-foreground-subtlest">职责</dt>
            <dd className="min-w-0 flex-1 break-words text-ui-sm leading-relaxed text-foreground-subtle">
              {member.purpose || "未填写"}
            </dd>
          </div>
        </dl>
        {onOpenSession ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-3 w-full justify-between text-foreground-subtle"
            onClick={() => onOpenSession(member.sessionId)}
          >
            打开它的会话
            <ArrowUpRight className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="text-ui-xs font-medium tracking-wide text-foreground-subtlest uppercase">
          在手任务
        </div>
        {ownTasks.length === 0 ? (
          <div className="mt-1.5 text-ui-sm text-foreground-subtlest">
            {member.currentTaskTitle ?? "手上没有任务"}
          </div>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {ownTasks.map((task) => (
              <li key={task.id} className="flex items-start gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    task.state === "done"
                      ? "bg-foreground-subtle"
                      : task.state === "failed"
                        ? "bg-destructive"
                        : "bg-warning",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-sm text-foreground/90">{task.title}</div>
                  <div className="text-ui-xs text-foreground-subtlest">
                    {task.state === "done" ? "已完成" : task.state === "failed" ? "失败" : "进行中"}
                    {task.revision > 0 ? ` · 退回 ${task.revision} 次` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <MemberMemory
          key={`${member.id}-memory`}
          workspacePath={workspacePath}
          memberName={member.name}
        />
      </div>
    </div>
  );
}

/**
 * 记忆的真身是 `.zcode/team/memory/<名字>.md`。
 * 选中时读一次，之后 5 秒刷一次：团队正在跑的时候，用户要能看到「它把我说的记下来了」。
 */
function MemberMemory({
  workspacePath,
  memberName,
}: {
  workspacePath: string;
  memberName: string;
}) {
  const { zcodeAgentService } = useServices();
  const [memory, setMemory] = useState<ZCodeTeamMemberMemoryResult | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const next = await zcodeAgentService.getTeamMemberMemory({ workspacePath, memberName });
      setMemory(next);
    } catch {
      // 读不到就保持上一次的样子：记忆是上下文，不是事实源。
    } finally {
      setLoading(false);
    }
  }, [memberName, workspacePath, zcodeAgentService]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void load();
    const timer = setInterval(() => {
      if (alive) void load();
    }, MEMORY_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  const parsed = useMemo(() => parseTeamMemory(memory?.text ?? ""), [memory?.text]);
  const entries = parsed.entries.slice(-MEMORY_ENTRY_LIMIT);

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <span className="text-ui-xs font-medium tracking-wide text-foreground-subtlest uppercase">
          记忆
        </span>
        {memory?.exists ? (
          <span className="text-ui-xs tabular-nums text-foreground-subtlest">
            {memory.chars} 字
            {memory.updatedAt ? ` · 更新于 ${formatTeamClock(memory.updatedAt)}` : ""}
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto grid size-5 place-items-center rounded text-foreground-subtlest hover:bg-hover hover:text-foreground-subtle"
          onClick={() => void load()}
          aria-label="刷新记忆"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </button>
      </div>

      {memory ? (
        <div className="mt-1 font-mono text-ui-xs break-all text-foreground-subtlest">
          {memory.path.replace(/\\/g, "/")}
        </div>
      ) : null}

      {loading && !memory ? (
        <div className="mt-2 space-y-1.5">
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      ) : !memory?.exists ? (
        <div className="mt-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-ui-xs leading-relaxed text-foreground-subtlest">
          它还没写过记忆。第一次被唤醒之后，每轮结束都会自动追加一行「收到什么 → 结果」。
        </div>
      ) : parsed.entries.length === 0 && parsed.notes.length === 0 ? (
        <div className="mt-2 text-ui-xs text-foreground-subtlest">记忆文件是空的</div>
      ) : (
        <>
          {entries.length > 0 ? (
            <ol className="mt-3 space-y-2.5 border-l border-border/70 pl-3">
              {entries.map((entry) => (
                <li key={entry.id} className="relative">
                  <span
                    aria-hidden
                    className="absolute top-1.5 -left-[15.5px] size-1.5 rounded-full bg-foreground-subtlest"
                  />
                  <div className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {entry.time}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-relaxed break-words text-foreground/90">
                    {entry.text}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {parsed.notes.length > 0 ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-card px-2.5 py-2">
              {parsed.notes.map((note) => (
                <p
                  key={note.slice(0, 24)}
                  className="text-ui-sm leading-relaxed whitespace-pre-wrap break-words text-foreground-subtle"
                >
                  {note}
                </p>
              ))}
            </div>
          ) : null}
          {memory?.truncated ? (
            <div className="mt-2 text-ui-xs text-foreground-subtlest">
              只显示最近的内容，完整记录在文件里
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
