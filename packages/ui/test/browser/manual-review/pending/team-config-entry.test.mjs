import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/team-config-entry.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/team-config-entry-browser");

let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "team-config-entry-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test("TCFG02 快照未带 config 时点配置仍能打开（旧 Host 兼容）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN&noSnapshotConfig=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    const openButton = page.getByTestId("team-config-open");
    await openButton.waitFor();
    await openButton.click();
    // 入口应主动调用 getTeamConfig 拿到配置并展开表单，而不是静默无反应。
    await page.getByText("团队配置", { exact: true }).waitFor();
    assert.equal(await page.locator('input[type="number"]').count(), 8);
    assert.equal(await page.locator('input[type="number"]').nth(0).inputValue(), "2");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("TCFG01 团队面板配置入口：展开、改并发、保存并回读", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    // 配置入口存在；点开前表单字段不可见。
    const openButton = page.getByTestId("team-config-open");
    await openButton.waitFor();
    assert.equal(await page.locator('input[type="number"]').count(), 0);

    await openButton.click();
    await page.getByText("团队配置", { exact: true }).waitFor();
    assert.equal(await openButton.getAttribute("aria-expanded"), "true");

    // 并发数初值来自快照配置（2）。
    const numberInputs = page.locator('input[type="number"]');
    assert.equal(await numberInputs.count(), 8);
    assert.equal(await numberInputs.nth(0).inputValue(), "2");

    // 改成 3，保存。
    await numberInputs.nth(0).fill("3");
    await page.getByRole("button", { name: "保存配置" }).click();
    await page.getByText("已保存").waitFor();

    // 服务层收到正确 patch：concurrency=3，limits 结构齐全，每分钟字段换算回毫秒。
    const probe = await page.evaluate(() => globalThis.__teamConfigProbe());
    assert.equal(probe.updateCalls, 1);
    assert.equal(probe.lastPatch.concurrency, 3);
    assert.equal(probe.lastPatch.limits.maxMembers, 8);
    assert.equal(probe.lastPatch.turnTimeoutMs, 30 * 60_000);
    assert.equal(probe.lastPatch.maxDurationMs, 2 * 60 * 60_000);
    assert.equal(probe.lastPatch.stallTimeoutMs, 10 * 60_000);

    await page.screenshot({ path: join(artifacts, "team-config-entry.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
