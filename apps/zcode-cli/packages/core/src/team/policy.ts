// ============================================================
// Team Policy — 权限矩阵
// ============================================================
// 全部规则只在这一处实现，工具层只调用、不解释。理由见 spec：
// 权限若散落在 prompt 与调用点，等于没有权限。
//
// 三条来自实际踩坑的规则：
//   1. **退回权不挂在组织层级上**。测试不是后端的上级，却必须能退它的货。
//      所以 reject 的判据是「目标任务已提交」，与 role 无关。
//   2. **只有主管能问用户**。放开给所有人，自动化会退化成轮流骚扰用户。
//   3. **招人要有上限**。一句「优化下性能」能递归烧出一支军队。

import type { TeamLimits, TeamRole } from "@zcode/contracts";

export type { TeamLimits };
export { DEFAULT_TEAM_LIMITS } from "@zcode/contracts";

export type PolicyResult = { ok: true } | { ok: false; reason: string };

const ALLOW: PolicyResult = { ok: true };

/** 每个角色能招的岗位。空数组 = 不能招人。 */
const HIRABLE: Record<TeamRole, readonly TeamRole[]> = {
  supervisor: ["pm", "ui", "lead"],
  pm: [],
  ui: [],
  lead: ["fe", "be", "qa"],
  fe: [],
  be: [],
  qa: [],
};

/** 每个角色能直接派活的岗位。不在表里的一律只能「问」，不能「派」。 */
const ASSIGNABLE: Record<TeamRole, readonly TeamRole[]> = {
  supervisor: ["pm", "ui", "lead"],
  pm: ["ui"],
  ui: [],
  lead: ["fe", "be", "qa"],
  fe: [],
  be: [],
  qa: [],
};

export function hirableRoles(role: TeamRole): readonly TeamRole[] {
  return HIRABLE[role];
}

export function assignableRoles(role: TeamRole): readonly TeamRole[] {
  return ASSIGNABLE[role];
}

export function canHire(input: {
  role: TeamRole;
  /** 招人者所在层级：主管 0。 */
  depth: number;
  memberCount: number;
  targetRole: TeamRole;
  limits: TeamLimits;
}): PolicyResult {
  const allowed = HIRABLE[input.role];
  if (allowed.length === 0) {
    return { ok: false, reason: `${input.role} 不能招人；需要人手上报上级` };
  }
  if (!allowed.includes(input.targetRole)) {
    return {
      ok: false,
      reason: `${input.role} 只能招 ${allowed.join('/')}，不能招 ${input.targetRole}`,
    };
  }
  if (input.memberCount >= input.limits.maxMembers) {
    return { ok: false, reason: `团队人数已达上限 ${input.limits.maxMembers}` };
  }
  if (input.depth + 1 >= input.limits.maxDepth) {
    return { ok: false, reason: `已达最大层级 ${input.limits.maxDepth}，不能再往下招人` };
  }
  return ALLOW;
}

export function canAssign(from: TeamRole, to: TeamRole): PolicyResult {
  if (ASSIGNABLE[from].includes(to)) return ALLOW;
  // 横向与向上都不是「派活」，只能「问」——两者的区别在消息种类与产出归属，不在措辞。
  return { ok: false, reason: `${from} 不能给 ${to} 派活；可以提问，但不能指派任务` };
}

export function canAskUser(role: TeamRole): PolicyResult {
  return role === "supervisor" ? ALLOW : { ok: false, reason: '只有主管能直接问用户；向上级上报' };
}

export function canDeliver(role: TeamRole): PolicyResult {
  return role === "supervisor" ? ALLOW : { ok: false, reason: "只有主管能向用户交付" };
}

/**
 * 退回不需要上下级关系：测试退后端的货是常态。
 * 判据是 revision 未达上限——到顶必须升级，这是防回退死循环的唯一手段。
 */
export function canReject(input: { revision: number; limits: TeamLimits }): PolicyResult {
  if (input.revision >= input.limits.maxRevisions) {
    return {
      ok: false,
      reason: `已打回 ${input.revision} 次，达到上限；请升级给上级裁决`,
    };
  }
  return ALLOW;
}

/** 只有拿到任务的人能提交，且任务必须仍是 open。 */
export function canSubmit(state: "open" | "done" | "failed"): PolicyResult {
  return state === "open" ? ALLOW : { ok: false, reason: "该任务已经结束，不能重复提交" };
}

export function questionHopExceeded(hop: number, limits: TeamLimits): PolicyResult {
  if (hop > limits.maxQuestionHops) {
    return {
      ok: false,
      reason: `问答链已 ${hop} 跳，超过 ${limits.maxQuestionHops} 跳上限；请升级给上级`,
    };
  }
  return ALLOW;
}
