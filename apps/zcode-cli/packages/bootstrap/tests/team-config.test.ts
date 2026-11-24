import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTeamConfig } from "../src/team/team-config.js";

const dirs: string[] = [];

function withConfig(raw: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-team-config-"));
  dirs.push(dir);
  // 团队配置现在在用户目录的团队存储根里，文件名仍是 team.json。
  const configPath = join(dir, "team.json");
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  return configPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录由系统清理。
    }
  }
});

describe("team config", () => {
  it("maxDurationMs: 0 解析为「不限」，不被默认值吞掉", () => {
    // positiveInt 会把 0 当成缺省值退回默认，那样「不限」就永远配不出来。
    const config = loadTeamConfig(withConfig({ name: "t", maxDurationMs: 0 }));

    expect(config?.maxDurationMs).toBe(0);
    expect(config?.turnTimeoutMs).toBe(30 * 60_000);
    expect(config?.stallTimeoutMs).toBe(10 * 60_000);
  });

  it("缺省时给出能跑真实交付的默认值", () => {
    const config = loadTeamConfig(withConfig({ name: "t" }));

    expect(config?.maxDurationMs).toBe(2 * 60 * 60_000);
    expect(config?.turnTimeoutMs).toBe(30 * 60_000);
    expect(config?.stallTimeoutMs).toBe(10 * 60_000);
  });

  it("看门狗阈值可配，0 表示关闭", () => {
    expect(loadTeamConfig(withConfig({ stallTimeoutMs: 0 }))?.stallTimeoutMs).toBe(0);
    expect(loadTeamConfig(withConfig({ stallTimeoutMs: 120_000 }))?.stallTimeoutMs).toBe(120_000);
    expect(loadTeamConfig(withConfig({ stallTimeoutMs: -1 }))?.stallTimeoutMs).toBe(10 * 60_000);
  });

  it("单轮上限可配，非法值退回默认", () => {
    expect(loadTeamConfig(withConfig({ turnTimeoutMs: 60 * 60_000 }))?.turnTimeoutMs).toBe(
      60 * 60_000,
    );
    expect(loadTeamConfig(withConfig({ turnTimeoutMs: -1 }))?.turnTimeoutMs).toBe(30 * 60_000);
  });
});
