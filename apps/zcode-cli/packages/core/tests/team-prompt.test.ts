// 成员的身份、岗位、模块边界和会话记忆声明由创建时的 system prompt（buildMemberPersona）承担；
// 长期记忆规则在团队契约里，记忆正文由 runtime 作为背景上下文注入。
// 每轮唤醒提示只保留动态上下文：团队目标、名册、收件箱、任务板、组建/交付模式。
// 模块在运行中可被 updateMember 修改；team-runtime 在下一轮开始前重算 persona 并刷新系统提示。
// 团队目标每次交付都会重写，不能固化进创建时的 persona。

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

function build(overrides: Partial<Parameters<typeof buildTeamTurnPrompt>[0]> = {}) {
  return buildTeamTurnPrompt({
    member: MEMBER,
    members: [SUPERVISOR, MEMBER],
    inbox: [MESSAGE],
    tasks: [TASK],
    goal: "给右侧预览区加独立窗口",
    ...overrides,
  });
}

describe("team member persona", () => {
  it("把岗位、职责、模块边界和会话记忆写进 system prompt", () => {
    const persona = buildMemberPersona(MEMBER);

    expect(persona).toContain(roleBrief("lead"));
    expect(persona).toContain("这个岗位在本团队里的职责：负责办公插件模块的实施与复核");
    expect(persona).toContain("你负责的模块：src/renderer/src/dock-plugins/**");
    expect(persona).toContain("你的会话和长期记忆只属于你");
  });

  it("没有模块时不留下空的模块说明", () => {
    const persona = buildMemberPersona({ ...MEMBER, module: "" });

    expect(persona).not.toContain("你负责的模块");
  });
});

describe("team turn prompt", () => {
  it("不再重复 system prompt 里的身份、岗位、模块和会话说明", () => {
    const prompt = build();

    expect(prompt).not.toContain("你的岗位：");
    expect(prompt).not.toContain(roleBrief("lead"));
    expect(prompt).not.toContain("你的会话就是你的记忆");
    expect(prompt).not.toContain("你负责的模块");
  });

  it("保留本轮动态上下文：目标、名册、收件箱和任务", () => {
    const prompt = build();

    expect(prompt).toContain("团队目标：给右侧预览区加独立窗口");
    expect(prompt).toContain("团队成员（用名字给他们发消息）");
    expect(prompt).toContain("这一轮叫醒你，是因为这些消息到了");
    expect(prompt).toContain("实现独立预览入口");
    expect(prompt).toContain("你手上未完成的任务");
  });

  it("主管不允许中途问用户，只能做假设并在交付里列出", () => {
    const prompt = build({ member: SUPERVISOR, members: [SUPERVISOR] });

    expect(prompt).toContain("不能中途问用户");
    expect(prompt).not.toContain("可以问用户");
  });

  it("组建期只切换本轮目标，不重复成员身份", () => {
    const prompt = build({ staffing: true });

    expect(prompt).toContain("现在是**组建期**");
    expect(prompt).not.toContain("你的岗位：");
  });

  it("本轮提示不再携带记忆正文、路径或保存指令", () => {
    const prompt = build();

    expect(prompt).not.toContain("你的长期记忆");
    expect(prompt).not.toContain("记忆文件");
    expect(prompt).not.toContain("（还没有记录）");
    expect(prompt).not.toContain("SaveMemory");
  });
});
