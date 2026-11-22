import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import {
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES,
  buildTeamDeliveryPrompt,
  buildTeamStaffingPrompt,
} from "@zcode/shared";

/**
 * 内置 `/team` 命令。
 *
 * 团队有两种意图，命令也分两种，判据是**有没有带参数**：
 *   - `/team`：组建期。主管去看项目、拆模块、招人，交出一份编制说明。
 *   - `/team 给设置页加导出`：交付期。把这票活交给已经在位的团队。
 *
 * 早先只有「交付」一种，导致团队是临阵招人：招谁取决于这一票活长什么样，
 * 项目本身没有稳定的组织结构。用户的期望是反过来的——团队是项目的常设组织。
 *
 * workspace 没有 `.zcode/team.json` 时不静默失败，而是把「怎么开」讲清楚。
 */

export const BUILTIN_TEAM_COMMAND_NAME = "team";

const helpEntry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_TEAM_COMMAND_NAME,
);
if (!helpEntry) {
  // 共享 help 表是保留字、TUI 候选与 App 目录的唯一来源；条目缺席时命令根本不可寻址。
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_TEAM_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_TEAM_COMMAND_NAME} `;
export const BUILTIN_TEAM_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_TEAM_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/**
 * 两段正文来自 `@zcode/shared` 的 `zcode-team-dispatch`：团队面板按钮发的是**同一段话**
 * （不经斜杠命令管线），所以必须逐字同源，改一处两边生效。
 */
const STAFFING_BODY = buildTeamStaffingPrompt();

/** 交付期正文。`$ARGUMENTS` 必须在场，否则展开会把参数追加成位置不受控的尾块。 */
const DELIVERY_BODY = buildTeamDeliveryPrompt("$ARGUMENTS");

export const BUILTIN_TEAM_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(DELIVERY_BODY),
  content: DELIVERY_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_TEAM_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_TEAM_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint"],
    name: BUILTIN_TEAM_COMMAND_NAME,
    path: `builtin:${BUILTIN_TEAM_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [],
    source: "zcode",
  },
  sizeBytes: Buffer.byteLength(DELIVERY_BODY),
  truncated: false,
};

const TEAM_CONFIG_RELATIVE_PATH = join(".zcode", "team.json");

export function isTeamConfigured(workingDirectory: string): boolean {
  return existsSync(join(workingDirectory, TEAM_CONFIG_RELATIVE_PATH));
}

const DISABLED_BODY = [
  "This workspace has no team yet: `.zcode/team.json` does not exist, so `StartTeam` has nothing",
  "to run. Calling it would only return an error.",
  "",
  "Tell the user, in their language, exactly this:",
  "1. 打开右侧侧栏的「团队」面板，点「创建团队」起一个名字（它会写 `.zcode/team.json`）；",
  "2. 或者手动在项目根目录建 `.zcode/team.json`，最小配置：",
  "",
  "```json",
  '{ "name": "交付小组", "supervisor": { "name": "主管" }, "concurrency": 2 }',
  "```",
  "",
  "3. 建好之后不需要重启：`/team` 会立刻生效，第一条不带参数就是组建团队。",
  "",
  "Then stop. Do not attempt the requested task yourself unless the user asks separately.",
].join("\n");

export function expandBuiltinTeamCommandPrompt(
  args: string,
  options: { enabled: boolean },
): string {
  if (!options.enabled) {
    const requested = args ? `\n\n用户这次想做的事（仅供你说明，不要执行）：\n${args}` : "";
    return `${DISABLED_BODY}${requested}`;
  }
  if (args.trim().length === 0) return STAFFING_BODY;
  return expandCustomCommandPrompt({ args, command: BUILTIN_TEAM_COMMAND }).prompt;
}
