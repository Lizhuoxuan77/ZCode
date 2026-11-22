import { describe, expect, it } from "vitest";
import type { TeamRole } from "@zcode/contracts";
import {
  DEFAULT_TEAM_LIMITS,
  canAssign,
  canHire,
  canAskUser,
  canDeliver,
  canReject,
  canSubmit,
  questionHopExceeded,
} from "../src/team/policy.js";

const limits = DEFAULT_TEAM_LIMITS;

describe("team policy", () => {
  it("主管能招 pm/ui/lead，招不了 fe", () => {
    for (const role of ["pm", "ui", "lead"] as const) {
      expect(
        canHire({ role: "supervisor", depth: 0, memberCount: 1, targetRole: role, limits }).ok,
      ).toBe(true);
    }
    expect(
      canHire({ role: "supervisor", depth: 0, memberCount: 1, targetRole: "fe", limits }),
    ).toMatchObject({ ok: false });
  });

  it("一线成员不能招人——需要人手上报组长", () => {
    for (const role of ["fe", "be", "qa", "ui", "pm"] as const) {
      expect(
        canHire({ role, depth: 1, memberCount: 4, targetRole: "fe", limits }),
      ).toMatchObject({ ok: false });
    }
  });

  it("人数与层级都有上限", () => {
    expect(
      canHire({ role: "lead", depth: 1, memberCount: limits.maxMembers, targetRole: "fe", limits }),
    ).toMatchObject({ ok: false });
    expect(
      canHire({ role: "lead", depth: limits.maxDepth, memberCount: 2, targetRole: "fe", limits }),
    ).toMatchObject({ ok: false });
  });

  it("派活是白名单：横向与向上只能问，不能派", () => {
    expect(canAssign("lead", "fe").ok).toBe(true);
    expect(canAssign("supervisor", "lead").ok).toBe(true);
    expect(canAssign("fe", "be").ok).toBe(false);
    expect(canAssign("fe", "lead").ok).toBe(false);
    expect(canAssign("pm", "lead").ok).toBe(false);
  });

  it("只有主管能问用户、能交付", () => {
    const others: TeamRole[] = ["pm", "ui", "lead", "fe", "be", "qa"];
    expect(canAskUser("supervisor").ok).toBe(true);
    expect(canDeliver("supervisor").ok).toBe(true);
    for (const role of others) {
      expect(canAskUser(role).ok).toBe(false);
      expect(canDeliver(role).ok).toBe(false);
    }
  });

  it("退回不挂在层级上：只看 revision 是否到顶", () => {
    expect(canReject({ revision: 0, limits }).ok).toBe(true);
    expect(canReject({ revision: limits.maxRevisions, limits })).toMatchObject({ ok: false });
  });

  it("任务已结束不能重复提交", () => {
    expect(canSubmit("open").ok).toBe(true);
    expect(canSubmit("done").ok).toBe(false);
    expect(canSubmit("failed").ok).toBe(false);
  });

  it("问答链超过上限要熔断", () => {
    expect(questionHopExceeded(limits.maxQuestionHops, limits).ok).toBe(true);
    expect(questionHopExceeded(limits.maxQuestionHops + 1, limits)).toMatchObject({ ok: false });
  });
});
