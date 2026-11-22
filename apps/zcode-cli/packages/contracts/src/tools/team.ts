import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// ============================================================
// Team Agent tools
// ============================================================
// 五个工具，全部只写状态、不等待：发消息不阻塞，要等结果用 awaitReply 把**自己**挂起，
// 由调度器在对方回复后重新唤醒。这样长链路（主管→组长→前端→后端）不会把上下文窗口
// 耗在等待上，进程中途死掉也能从磁盘接着跑。

export const TEAM_START_TOOL_NAME = "StartTeam";
export const TEAM_CREATE_MEMBER_TOOL_NAME = "CreateTeammate";
export const TEAM_MESSAGE_TOOL_NAME = "MessageTeammate";
export const TEAM_SUBMIT_TOOL_NAME = "SubmitTask";
export const TEAM_DELIVER_TOOL_NAME = "DeliverResult";

export const TEAM_ROLE_VALUES = ["supervisor", "pm", "ui", "lead", "fe", "be", "qa"] as const;
export const TEAM_MESSAGE_KINDS = ["task", "result", "question", "answer", "system", "reject"] as const;

const MAX_CONTENT = 20_000;

export const TeamCreateMemberInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .describe("Unique name inside the team. Used to address this member later."),
    role: z.enum(TEAM_ROLE_VALUES).describe("Post this member fills; determines permissions."),
    purpose: z
      .string()
      .min(1)
      .max(300)
      .describe("Why this post exists in THIS project — one sentence, not a job description."),
    module: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe(
        "The part of the project this member owns: directories, files, or responsibility boundary. " +
          "Required during staffing — two members must not own the same files.",
      ),
  })
  .strict();

export type TeamCreateMemberInput = z.infer<typeof TeamCreateMemberInputSchema>;

export const TeamCreateMemberInputJsonSchema = toToolJsonSchema(TeamCreateMemberInputSchema);

export const TeamMessageInputSchema = z
  .object({
    to: z.string().min(1).max(60).describe("Teammate name."),
    kind: z
      .enum(TEAM_MESSAGE_KINDS)
      .describe("task = assign work; question = need an answer; answer/result/reject = outcome."),
    content: z.string().min(1).max(MAX_CONTENT).describe("Message body. Be specific and self-contained: the recipient does not share your context."),
    title: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Short label for a task assignment (what lists and the team panel show). Keep the full instructions in `content`.",
      ),
    phase: z
      .enum(["plan", "design", "build", "verify"])
      .optional()
      .describe("Which delivery stage this work belongs to; drives the panel's phase bar."),
    refs: z
      .array(z.string().max(300))
      .max(20)
      .optional()
      .describe("Paths, task ids or message ids the recipient should read instead of guessing."),
    awaitReply: z
      .boolean()
      .optional()
      .describe("true = finish this turn and get woken when they reply. false/omitted = keep going."),
    timeoutSec: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .describe("How long to wait before you are woken with a timeout notice (default 600)."),
  })
  .strict();

export type TeamMessageInput = z.infer<typeof TeamMessageInputSchema>;

export const TeamMessageInputJsonSchema = toToolJsonSchema(TeamMessageInputSchema);

export const TeamSubmitInputSchema = z
  .object({
    taskId: z.string().max(60).optional().describe("Defaults to your single open task."),
    result: z.string().min(1).max(MAX_CONTENT).describe("What you produced, where it is, how it was verified."),
    state: z.enum(["done", "failed"]).describe("done = delivered; failed = could not complete."),
  })
  .strict();

export type TeamSubmitInput = z.infer<typeof TeamSubmitInputSchema>;

export const TeamSubmitInputJsonSchema = toToolJsonSchema(TeamSubmitInputSchema);

export const TeamDeliverInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MAX_CONTENT)
      .describe("Final answer for the user, ending with the decisions you made on their behalf."),
  })
  .strict();

export type TeamDeliverInput = z.infer<typeof TeamDeliverInputSchema>;

export const TeamDeliverInputJsonSchema = toToolJsonSchema(TeamDeliverInputSchema);

export const TeamStartInputSchema = z
  .object({
    mode: z
      .enum(["init", "deliver"])
      .describe(
        "init = staff the team: survey this project, decide the modules, hire one owner per module, then report the roster. " +
          "deliver = hand a concrete requirement to the already-staffed team.",
      ),
    requirement: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe(
        "The user's requirement, verbatim where possible. Required for mode=deliver; omit for mode=init.",
      ),
  })
  .strict()
  .refine((input) => input.mode === "init" || input.requirement !== undefined, {
    message: "mode=deliver requires `requirement`",
    path: ["requirement"],
  });

export type TeamStartInput = z.infer<typeof TeamStartInputSchema>;

export const TeamStartInputJsonSchema = toToolJsonSchema(TeamStartInputSchema);
