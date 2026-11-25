// 身份契约：成员 id 是唯一寻址键，名字只用于展示。
// 这里用真实 TeamStore 验证 send / updateMember 只认 id：传名字必须明确失败，
// 不能碰巧命中同名成员，也不能因为改名/清洗撞车把消息投错人。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS, TeamFlowError } from "@zcode/contracts";
import { TeamStore } from "../src/team/team-store.js";

const dirs: string[] = [];
const stores: TeamStore[] = [];

function newStore(): TeamStore {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-identity-"));
  dirs.push(dir);
  const store = new TeamStore({
    file: join(dir, "team.db"),
    limits: DEFAULT_TEAM_LIMITS,
    idPrefix: "t",
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
});

function setup() {
  const store = newStore();
  const supervisor = store.createSupervisor({
    name: "主管",
    role: "supervisor",
    purpose: "接需求",
  });
  const member = store.createMember({
    bySessionId: supervisor.sessionId,
    name: "组长",
    role: "lead",
    purpose: "实现",
  });
  return { store, supervisor, member };
}

describe("team member identity", () => {
  it("发消息只按成员 id 寻址，消息落在收件人的 id 上", () => {
    const { store, supervisor, member } = setup();

    const message = store.send({
      fromSessionId: supervisor.sessionId,
      to: member.id,
      kind: "question",
      content: "接口定了吗",
    });

    expect(message.to).toBe(member.id);
    expect(store.tasks()).toHaveLength(0);
  });

  it("把名字当收件人时明确失败，不会碰巧解析到同名成员", () => {
    const { store, supervisor } = setup();

    expect(() =>
      store.send({
        fromSessionId: supervisor.sessionId,
        to: "组长",
        kind: "question",
        content: "接口定了吗",
      }),
    ).toThrow(TeamFlowError);
  });

  it("updateMember 按 id 定位；传名字同样失败", () => {
    const { store, supervisor, member } = setup();

    const updated = store.updateMember({
      bySessionId: supervisor.sessionId,
      memberId: member.id,
      module: "src/**",
    });
    expect(updated.id).toBe(member.id);
    expect(updated.module).toBe("src/**");

    expect(() =>
      store.updateMember({
        bySessionId: supervisor.sessionId,
        memberId: "组长",
        module: "other/**",
      }),
    ).toThrow(TeamFlowError);
    expect(store.memberById(member.id)?.module).toBe("src/**");
  });
});