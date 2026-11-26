import { createRoot } from "react-dom/client";
import { TeamSidePane } from "@/app-shell/TeamSidePane.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { IServiceAccessor } from "@zcode/services";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);

const config = {
  name: "验收小队",
  supervisor: { name: "主管", purpose: "接需求、组队、验收" },
  limits: { maxMembers: 8, maxDepth: 3, maxRevisions: 1, maxQuestionHops: 3 },
  concurrency: 2,
  maxDurationMs: 2 * 60 * 60_000,
  turnTimeoutMs: 30 * 60_000,
  stallTimeoutMs: 10 * 60_000,
};

let updateCalls = 0;
let lastPatch: Record<string, unknown> | null = null;
const services = {
  zcodeAgentService: {
    getTeamSnapshot: async () => ({
      configured: true,
      started: true,
      teamName: config.name,
      // ?noSnapshotConfig=1 模拟旧 Host 快照未带 config 的情况，验证入口主动读取仍可用。
      ...(params.has("noSnapshotConfig") ? {} : { config }),
      goal: "验收团队配置入口",
      members: [
        {
          id: "m1",
          name: "主管",
          role: "supervisor",
          status: "idle",
          depth: 0,
          parentId: null,
          purpose: "组织交付",
          sessionId: "s1",
          module: "",
        },
      ],
      tasks: [],
      messages: [],
      readAt: Date.now(),
    }),
    getTeamConfig: async () => ({ path: "/tmp/team.json", config }),
    updateTeamConfig: async (_params: unknown, patch: Record<string, unknown>) => {
      updateCalls += 1;
      lastPatch = patch;
      return { path: "/tmp/team.json", config };
    },
  },
} as unknown as IServiceAccessor;

(window as unknown as Record<string, unknown>).__teamConfigProbe = () => ({
  updateCalls,
  lastPatch,
});

function Fixture() {
  return (
    <main className="h-screen w-full bg-background text-foreground">
      <div className="h-full w-[380px] border-r border-border">
        <TeamSidePane
          tab={{ id: "team:app", type: "team", workspaceKey: "app", workspacePath: "/work/app" }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <Fixture />
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
