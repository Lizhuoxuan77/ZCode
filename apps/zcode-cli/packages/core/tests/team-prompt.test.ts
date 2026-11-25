// 固定内容一律进 system prompt：身份、岗位、模块边界、会话记忆声明、团队目标、
// 成员名册、权限矩阵、工作方式（或组建期指引）。每轮唤醒的 query 只保留这一轮要做的事：
// 未完成任务、收件箱消息与上一轮失败说明。
// 模块/职责/目标/名册在运行中可能变化；team-runtime 在下一轮开始前重算 persona，
// 只有文本变了才刷新 system prompt。

import {
  createSessionId,
  type TeamMemberRef,
  type TeamMessageRef,
  type TeamTaskRef,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { buildMemberPersona, buildTeamTurnPrompt } from "../src/team/prompt.js";
import { roleBrief } from "../src/team/roles.js";

const MEMBER: TeamMemberRef = {
  id: "tm_member_lead",
  name: "组长-办公插件",
  role: "lead",
  parentId: "tm_member_supervisor",
  depth: 1,
  status: "idle",
  sessionId: createSessionId("team-prompt-lead"),
  purpose: "负责办公插件模块的实施与复核",
  module: "src/renderer/src/dock-plugins/**",
};

const SUPERVISOR: TeamMemberRef = {
  id: "tm_member_supervisor",
  name: "主管",
  role: "supervisor",
  parentId: null,
  depth: 0,
  status: "idle",
  sessionId: createSessionId("team-prompt-supervisor"),
  purpose: "接需求、组队、验收、向用户交付",
  module: "",
};

const TASK: TeamTaskRef = {
  id: "tm_task_preview",
  ownerId: MEMBER.id,
  title: "给工作台文件/浏览器页签加独立预览入口",
  state: "open",
  revision: 0,
  createdAt: 1,
};

const MESSAGE: TeamMessageRef = {
  id: "tm_msg_preview",
  from: SUPERVISOR.id,
  to: MEMBER.id,
  kind: "task",
  content: "实现独立预览入口",
  refs: [],
  createdAt: 2,
};

const PERSONA_CONTEXT = {
  goal: "给右侧预览区加独立窗口",
  members: [SUPERVISOR, MEMBER],
};

function buildPersona(member: TeamMemberRef, overrides: Partial<typeof PERSONA_CONTEXT> = {}) {
  return buildMemberPersona(member, { ...PERSONA_CONTEXT, ...overrides });
}

function buildTurn(overrides: Partial<Parameters<typeof buildTeamTurnPrompt>[0]> = {}) {
  return buildTeamTurnPrompt({
    member: MEMBER,
    members: [SUPERVISOR, MEMBER],
    inbox: [MESSAGE],
    tasks: [TASK],
    ...overrides,
  });
}

describe("team member persona", () => {
  it("把岗位、职责、模块边界和会话记忆写进 system prompt", () => {
    const persona = buildPersona(MEMBER);

    expect(persona).toContain(roleBrief("lead"));
    expect(persona).toContain("这个岗位在本团队里的职责：负责办公插件模块的实施与复核");
    expect(persona).toContain("你负责的模块：src/renderer/src/dock-plugins/**");
    expect(persona).toContain("你的会话和长期记忆只属于你");
  });

  it("没有模块时不留下空的模块说明", () => {
    const persona = buildPersona({ ...MEMBER, module: "" });

    expect(persona).not.toContain("你负责的模块");
  });

  it("把团队目标、成员名册、权限与工作方式写进 system prompt", () => {
    const persona = buildPersona(MEMBER);

    expect(persona).toContain("团队目标：给右侧预览区加独立窗口");
    expect(persona).toContain("团队成员（发消息时收件人写成员 id");
    expect(persona).toContain("组长-办公插件");
    expect(persona).toContain("组长（你）");
    expect(persona).toContain("负责 src/renderer/src/dock-plugins/**");
    expect(persona).toContain("你的权限：");
    expect(persona).toContain("可以派活给：前端、后端、测试");
    expect(persona).toContain("你的工作方式：");
    expect(persona).toContain("收件人写名册里的成员 id");
    expect(persona).toContain("这一轮没有可做的事就直接结束");
  });

  it("名册用 id 寻址：每个名字后面都带稳定 id", () => {
    const persona = buildPersona(MEMBER);

    expect(persona).toContain("组长-办公插件（id:tm_member_lead）");
    expect(persona).toContain("主管（id:tm_member_supervisor）");
  });

  it("名册不带实时状态：状态每轮都变，写进 system prompt 会让前缀每轮失效", () => {
    const persona = buildPersona(MEMBER);

    expect(persona).not.toContain("idle");
    expect(persona).not.toContain("running");
    expect(persona).not.toContain("waiting");
  });

  it("主管不允许中途问用户，只能做假设并在交付里列出", () => {
    const persona = buildPersona(SUPERVISOR);

    expect(persona).toContain("不能中途问用户");
    expect(persona).toContain("全队收尾后用 DeliverResult 交付给用户");
    expect(persona).not.toContain("可以问用户");
  });

  it("组建期把阶段指引放进主管的 system prompt，不放进普通成员", () => {
    const supervisor = buildPersona(SUPERVISOR, { staffing: true });
    const lead = buildPersona(MEMBER, { staffing: true });

    expect(supervisor).toContain("现在是**组建期**");
    expect(supervisor).not.toContain("你的工作方式：");
    expect(lead).not.toContain("现在是**组建期**");
    expect(lead).toContain("你的工作方式：");
  });

  it("没有团队背景时仍保留与阶段无关的权限和工作规则", () => {
    const persona = buildMemberPersona(MEMBER);

    expect(persona).toContain("你的权限：");
    expect(persona).toContain("你的工作方式：");
    expect(persona).not.toContain("团队目标：");
  });
});

describe("team turn prompt", () => {
  it("不再重复 system prompt 里的身份、目标、名册、权限和工作规则", () => {
    const prompt = buildTurn();

    expect(prompt).not.toContain("你的岗位：");
    expect(prompt).not.toContain(roleBrief("lead"));
    expect(prompt).not.toContain("你的会话就是你的记忆");
    expect(prompt).not.toContain("你负责的模块");
    expect(prompt).not.toContain("团队目标：");
    expect(prompt).not.toContain("团队成员（");
    expect(prompt).not.toContain("你的权限：");
    expect(prompt).not.toContain("你的工作方式：");
    expect(prompt).not.toContain("硬规则");
    expect(prompt).not.toContain("现在是**组建期**");
  });

  it("只保留本轮要做的事：未完成任务、收件箱消息", () => {
    const prompt = buildTurn();

    expect(prompt).toContain("这一轮叫醒你，是因为这些消息到了");
    expect(prompt).toContain("实现独立预览入口");
    // 发件人同样带 id，收件人可以按 id 回消息。
    expect(prompt).toContain("来自 主管（id:tm_member_supervisor）");
    expect(prompt).toContain("你手上未完成的任务");
  });

  it("没有新消息时提示接着处理未完成任务", () => {
    const prompt = buildTurn({ inbox: [] });

    expect(prompt).toContain("这一轮叫醒你没有带新消息");
  });

  it("上一轮失败说明留在 query：它是本轮动态信息", () => {
    const prompt = buildTurn({ failure: "工具调用失败" });

    expect(prompt).toContain("上一轮执行失败：工具调用失败");
  });

  it("本轮提示不再携带记忆正文、路径或保存指令", () => {
    const prompt = buildTurn();

    expect(prompt).not.toContain("你的长期记忆");
    expect(prompt).not.toContain("记忆文件");
    expect(prompt).not.toContain("（还没有记录）");
    expect(prompt).not.toContain("SaveMemory");
  });
});