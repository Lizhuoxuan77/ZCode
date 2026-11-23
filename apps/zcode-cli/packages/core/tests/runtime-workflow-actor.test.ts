// 团队成员创建后仍可能改模块/职责。更新身份段只换 config.workflowActor，不重建 runtime；
// 下一轮开始前没有 activeTurn，重建 context prefix 后新 system prompt 才会生效。
// 这里用最小 fixture 验证替换事实；重建 prefix 的完整链路由 context-builder 测试覆盖。

import { describe, expect, it } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { updateWorkflowActor } from "../src/runtime/methods/config.js";

describe("updateWorkflowActor", () => {
  it("只替换身份段，保留其余运行时配置", () => {
    const runtime = {
      config: {
        workflowActor: { name: "旧名字", persona: "旧人设", kind: "team" },
        mode: "yolo",
      },
      // 有 activeTurn 时不重建 context prefix，避免在一个回合中途换 system prompt。
      activeTurn: {},
    } as unknown as AgentRuntimeInternal;

    updateWorkflowActor.call(runtime, {
      name: "新名字",
      persona: "新人设",
      kind: "team",
    });

    expect(runtime.config.workflowActor).toEqual({
      name: "新名字",
      persona: "新人设",
      kind: "team",
    });
    expect(runtime.config.mode).toBe("yolo");
  });

  it("允许清除身份段", () => {
    const runtime = {
      config: { workflowActor: { name: "临时演员", persona: "临时人设" } },
      activeTurn: {},
    } as unknown as AgentRuntimeInternal;

    updateWorkflowActor.call(runtime, undefined);

    expect(runtime.config.workflowActor).toBeUndefined();
  });
});
