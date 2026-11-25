// ============================================================
// Team Port — 交给工具层的那一个对象
// ============================================================
// 两个身份共用一个端口：
//   - 主会话：只有 `start`（StartTeam），不是成员
//   - 团队成员会话：有 member/send/submit/deliver，没有 start
// 谁是成员由 `member(sessionId)` 回答——工具注册门读的就是它，模型无法伪造身份。
//
// **开关是「有没有配置」，不是「有没有这个方法」**：`start` 恒在场，
// 每次调用都会重读用户目录里的团队配置；没有配置就返回一条让模型能转告用户的提示。
//
// 惰性打开：没有配置时连 SQLite 都不碰。不用团队的项目不会多出一个数据库文件。

import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import {
  DEFAULT_TEAM_LIMITS,
  TeamFlowError,
  type Logger,
  type SessionId,
  type TeamCreateMemberRequest,
  type TeamLimits,
  type TeamMemberRef,
  type TeamPort,
  type TeamSaveMemoryRequest,
  type TeamSendMessageRequest,
  type TeamStartMode,
  type TeamStartResult,
  type TeamSubmitRequest,
  type TeamUpdateMemberRequest,
  type TeamTaskRef,
  type TraceContext,
} from "@zcode/contracts";
import type { TeamStoragePaths } from "@zcode/shared/node";
import type { ScriptWorkflowAgentRuntimeDeps } from "../app/script-workflow-child-runtime.js";
import { loadTeamConfig, type TeamConfig } from "./team-config.js";
import { appendSavedMemory, migrateMemberMemoryFiles } from "./team-memory.js";
import { createAgentRuntimeTeamRunner, type AgentRuntimeTeamRunner } from "./team-runtime.js";
import { TeamService } from "./team-service.js";
import { migrateLegacyTeamStorage } from "./team-storage.js";
import { TeamStore } from "./team-store.js";

export interface TeamPortHandle extends TeamPort {
  dispose(): Promise<void>;
}

export function createTeamPort(input: {
  workingDirectory: string;
  /** 团队数据在用户目录里的位置；项目里不再写任何团队文件。 */
  storage: TeamStoragePaths;
  logger: Logger;
  traceContext: TraceContext;
  /** 惰性：主 runtime 在工具注册之后才就绪，端口不能反过来要求它先存在。 */
  getRuntimeDeps: () => ScriptWorkflowAgentRuntimeDeps;
}): TeamPortHandle {
  // 旧版本把团队写在项目里；启动时先搬一次，再开始读配置/开库。
  // 非团队项目只做两次 existsSync，不产生任何目录。
  migrateLegacyTeamStorage({
    workspacePath: input.workingDirectory,
    storage: input.storage,
    logger: input.logger,
  });
  let store: TeamStore | undefined;
  let runner: AgentRuntimeTeamRunner | undefined;
  let running: Promise<TeamStartResult> | undefined;
  let controller: AbortController | undefined;

  const start = async (startInput: {
    sessionId: SessionId;
    mode: TeamStartMode;
    requirement?: string;
    signal?: AbortSignal;
  }): Promise<TeamStartResult> => {
    const current = readConfig();
    if (!current) {
      return {
        ok: false,
        summary:
          "这个项目还没有团队，所以没有可发起的交付。请让用户打开右侧侧栏的「团队」面板，点「创建团队」起一个名字。" +
          "团队配置保存在 ZCode 的用户数据目录，不会写进项目；建好之后不需要重启，再调用一次即可。",
      };
    }
    // 同一个团队同时只跑一次交付：两次交付共用一块任务板，谁也分不清哪条消息属于哪次。
    if (running) return running;

    const activeStore = openStore(current);
    controller = new AbortController();
    const { signal } = startInput;
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller?.abort(), { once: true });
    }
    const teamSignal = controller.signal;

    runner ??= createAgentRuntimeTeamRunner({
      deps: { ...input.getRuntimeDeps(), teamPort: handle },
      logger: input.logger,
      traceContext: input.traceContext,
    });

    const service = new TeamService({
      store: activeStore,
      runner,
      supervisor: {
        name: current.supervisor.name,
        role: "supervisor",
        purpose: current.supervisor.purpose,
      },
      concurrency: current.concurrency,
      maxDurationMs: current.maxDurationMs,
      turnTimeoutMs: current.turnTimeoutMs,
      stallTimeoutMs: current.stallTimeoutMs,
      logger: input.logger,
      projectName: basename(input.workingDirectory) || current.name,
      memoryDir: input.storage.memoryDir,
    });

    if (startInput.mode === "init") {
      running = service.staff({ signal: teamSignal }).finally(() => {
        running = undefined;
      });
      return running;
    }

    const requirement = startInput.requirement?.trim() ?? "";
    if (requirement.length === 0) {
      return { ok: false, summary: "交付模式需要一条具体需求；只说「做点事」团队没法拆。" };
    }
    running = service.run({ requirement, signal: teamSignal }).finally(() => {
      running = undefined;
    });
    return running;
  };

  const handle: TeamPortHandle = {
    member(sessionId: SessionId): TeamMemberRef | undefined {
      const current = readConfig();
      if (!current) return undefined;
      if (store === undefined && !existsSync(input.storage.databasePath)) return undefined;
      return openStore(current).member(sessionId);
    },

    members(): readonly TeamMemberRef[] {
      return store?.members() ?? [];
    },

    tasks(): readonly TeamTaskRef[] {
      return store?.tasks() ?? [];
    },

    limits(): TeamLimits {
      return store?.limits() ?? readConfig()?.limits ?? DEFAULT_TEAM_LIMITS;
    },

    createMember(memberInput: TeamCreateMemberRequest): TeamMemberRef {
      const store = requireStore();
      const ref = store.createMember(memberInput);
      // 招进来立刻把会话落库（不跑任何一轮）：成员在第一次被叫醒前也必须有页面可点，
      // 否则组建期点新成员 = "Session not found"。落库失败不阻断招人——第一次被叫醒时还会再落。
      try {
        runner ??= createAgentRuntimeTeamRunner({
          deps: { ...input.getRuntimeDeps(), teamPort: handle },
          logger: input.logger,
          traceContext: input.traceContext,
        });
        // 目标与名册写进 system prompt：招人这一刻的编制就是这个人设的一部分，
        // 之后每轮由 runner 与上一轮快照比对，变了才刷新。
        void runner
          .prepare(ref, { goal: store.getMeta("goal") ?? "", members: store.members() })
          .catch((error: unknown) => {
            input.logger.warn(`Team member session prepare failed: ${ref.name}`, {
              event: "team.member.prepare_failed",
              module: "bootstrap.team",
              member: ref.name,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } catch (error) {
        input.logger.warn(`Team member prepare skipped: ${ref.name}`, {
          event: "team.member.prepare_skipped",
          module: "bootstrap.team",
          member: ref.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return ref;
    },

    updateMember(memberInput: TeamUpdateMemberRequest): TeamMemberRef {
      return requireStore().updateMember(memberInput);
    },

    send(messageInput: TeamSendMessageRequest) {
      return requireStore().send(messageInput);
    },

    submit(submitInput: TeamSubmitRequest): TeamTaskRef {
      return requireStore().submit(submitInput);
    },

    saveMemory(memoryInput: TeamSaveMemoryRequest): void {
      // 身份只来自调用会话：模型不能传名字或 id 给别人的记忆写东西。
      const member = requireStore().member(memoryInput.fromSessionId);
      if (!member) {
        throw new TeamFlowError("当前会话不是团队成员，不能保存记忆。");
      }
      try {
        // 落盘按成员 id，不按名字：名字是展示标签，不是身份。
        appendSavedMemory(input.storage.memoryDir, member, {
          kind: memoryInput.kind,
          content: memoryInput.content,
        });
      } catch (error) {
        throw new TeamFlowError(
          `保存记忆失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    deliver(deliverInput: { fromSessionId: SessionId; content: string }): void {
      requireStore().deliver(deliverInput);
    },

    // `start` 恒在场。曾经这里按「构造那一刻有没有配置」决定挂不挂，结果是：
    // 端口在应用启动时构造，用户之后在面板里建了团队，`start` 永远不会补上——
    // 工具看得见，点下去却报 "Team start port is not configured"。
    // 配置是否存在改由 start 内部每次重读判断（没有配置就返回一条可读的提示）。
    start,

    async dispose(): Promise<void> {
      // 先叫停调度循环，再关子会话：否则关库时循环还在写。
      controller?.abort();
      controller = undefined;
      await running?.catch(() => undefined);
      running = undefined;
      await runner?.dispose();
      store?.close();
      store = undefined;
    },
  };

  return handle;

  // 每次调用都重读磁盘：面板里「新建团队」写完之后，当前会话不必重启就能用上。
  // 一次 stat+read 的开销远小于重启会话的代价，而团队配置改动频率极低。
  function readConfig(): TeamConfig | undefined {
    return loadTeamConfig(input.storage.configPath);
  }

  function openStore(current: TeamConfig): TeamStore {
    store ??= (() => {
      // SQLite 不会替我们建目录；团队目录不存在时先建，首次开库才成功。
      mkdirSync(input.storage.root, { recursive: true });
      const created = new TeamStore({
        file: input.storage.databasePath,
        limits: current.limits,
      });
      // 升级前的记忆文件按名字命名；开库这一刻知道全部成员 id，一次性迁到 id 文件名。
      // 幂等：目标已存在就跳过，失败保留旧文件等下次启动重试。
      const migration = migrateMemberMemoryFiles(input.storage.memoryDir, created.members());
      if (migration.migrated > 0) {
        input.logger.info("Team member memory migrated to member ids", {
          event: "team.memory.migrated",
          module: "bootstrap.team",
          migrated: migration.migrated,
        });
      }
      if (migration.legacyKept > 0) {
        input.logger.warn("Team memory migration kept legacy files", {
          event: "team.memory.migration_incomplete",
          module: "bootstrap.team",
          legacyKept: migration.legacyKept,
        });
      }
      return created;
    })();
    return store;
  }

  function requireStore(): TeamStore {
    const current = readConfig();
    if (!current) throw new Error("team is not configured for this workspace");
    return openStore(current);
  }
}
