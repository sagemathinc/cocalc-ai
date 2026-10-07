/**
 * `cocalc project browser start|status|stop|ask-human`: the shared browser
 * an agent drives over CDP while a human watches and can take over in a
 * chat card.  The browser itself runs as the project app `cocalc-browser`
 * (`cocalc project browser serve`).
 */
import { Command } from "commander";

import { SHARED_BROWSER_APP_ID } from "../../core/shared-browser/service";
import type { SharedBrowserState } from "../../core/shared-browser/server";
import type { ProjectCommandDeps } from "../project";

const CARD_TITLE = "Shared browser";
const CARD_TEXT =
  "A browser in this project that the agent drives and you can watch. Take over at any time; the agent waits until you hand back.";

export function sharedBrowserAppSpec({
  exec,
  args,
}: {
  exec: string;
  args: string[];
}) {
  return {
    version: 1,
    id: SHARED_BROWSER_APP_ID,
    title: CARD_TITLE,
    kind: "service",
    command: { exec, args },
    lifecycle: { mode: "managed" },
    network: { listen_host: "127.0.0.1", protocol: "http" },
    proxy: {
      base_path: `/apps/${SHARED_BROWSER_APP_ID}`,
      strip_prefix: true,
      websocket: true,
      open_mode: "proxy",
      health_path: "/healthz",
      readiness_timeout_s: 30,
    },
    wake: { enabled: true, keep_warm_s: 30 * 60, startup_timeout_s: 45 },
  };
}

// Inside the target project, run the service with exactly this CLI; from
// elsewhere, with the project's own `cocalc`.
export function serveCommand(targetProjectId: string): {
  exec: string;
  args: string[];
} {
  const here = process.env.COCALC_PROJECT_ID === targetProjectId;
  return here && process.argv[1]
    ? {
        exec: process.execPath,
        args: [process.argv[1], "project", "browser", "serve"],
      }
    : { exec: "cocalc", args: ["project", "browser", "serve"] };
}

async function serviceState(port?: number): Promise<SharedBrowserState | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    return res.ok ? ((await res.json()) as SharedBrowserState) : null;
  } catch {
    // Not reachable from here (e.g. run outside the project).
    return null;
  }
}

async function post(port: number, path: string, body: object) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as SharedBrowserState;
}

type ChatTarget = { path?: string; threadId?: string; messageDate?: string };

function chatTarget(opts: ChatTarget): Required<ChatTarget> | null {
  const path = opts.path ?? process.env.COCALC_CODEX_CHAT_PATH;
  const threadId = opts.threadId ?? process.env.COCALC_CODEX_THREAD_ID;
  const messageDate = opts.messageDate ?? process.env.COCALC_CODEX_MESSAGE_DATE;
  return path && threadId && messageDate
    ? { path, threadId, messageDate }
    : null;
}

export function registerSharedBrowserCommands(
  browser: Command,
  deps: ProjectCommandDeps,
): void {
  const { withContext, resolveProjectProjectApi, projectChatArtifactData } =
    deps;

  const running = async (ctx: any, project?: string) => {
    const { project: p, api } = await resolveProjectProjectApi(ctx, project);
    const status = await api.apps.statusApp(SHARED_BROWSER_APP_ID);
    return { project: p, api, status };
  };

  browser
    .command("start")
    .description(
      "start (or reuse) the shared browser and show it in a chat card; prints the CDP endpoint agents use (Playwright connectOverCDP, Puppeteer connect, chrome-devtools-mcp --browser-url)",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--path <path>",
      "chat for the card (default: $COCALC_CODEX_CHAT_PATH)",
    )
    .option(
      "--thread-id <id>",
      "thread for the card (default: $COCALC_CODEX_THREAD_ID)",
    )
    .option(
      "--message-date <date>",
      "producing message timestamp (default: $COCALC_CODEX_MESSAGE_DATE)",
    )
    .option("--no-card", "do not publish a chat card")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "project browser start", async (ctx: any) => {
        const { project, api } = await resolveProjectProjectApi(
          ctx,
          opts.project,
        );
        await api.apps.upsertAppSpec(
          sharedBrowserAppSpec(serveCommand(project.project_id)),
        );
        const status = await api.apps.ensureRunning(SHARED_BROWSER_APP_ID, {
          timeout: 60_000,
          interval: 500,
        });
        const state = await serviceState(status.port);

        let card: { artifact_id: string; reused: boolean } | null = null;
        let cardNote: string | undefined;
        const target = chatTarget(opts);
        if (opts.card !== false && target) {
          const common = {
            ctx,
            experimental: true,
            projectIdentifier: project.project_id,
            path: target.path,
            threadId: target.threadId,
          };
          const existing = ((await projectChatArtifactData({
            ...common,
            action: "list",
          })) ?? []) as any[];
          const found = existing.find(
            (a) => a.kind === "app" && a.app?.id === SHARED_BROWSER_APP_ID,
          );
          if (found) card = { artifact_id: found.artifact_id, reused: true };
          else {
            const published = await projectChatArtifactData({
              ...common,
              action: "publish",
              messageDate: target.messageDate,
              payload: {
                title: CARD_TITLE,
                markdown: CARD_TEXT,
                app: { id: SHARED_BROWSER_APP_ID },
              },
            });
            card = { artifact_id: published.artifact_id, reused: false };
          }
        } else if (opts.card !== false) {
          cardNote =
            "No card published: pass --path, --thread-id and --message-date for the current chat turn.";
        }
        return {
          project_id: project.project_id,
          app_id: SHARED_BROWSER_APP_ID,
          cdp: state?.cdp ?? null,
          driver: state?.driver ?? null,
          card,
          ...(cardNote ? { note: cardNote } : {}),
          usage:
            "Connect with CDP at `cdp` (e.g. Playwright chromium.connectOverCDP(cdp) and use its existing context and page). While the human has taken over, page actions wait until they hand back. To ask the human to take over (logins, CAPTCHAs): cocalc project browser ask-human --message '...' --wait",
        };
      });
    });

  browser
    .command("status")
    .description("show the shared browser: driver, tabs, CDP endpoint")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "project browser status", async (ctx: any) => {
        const { project, status } = await running(ctx, opts.project);
        const state =
          status.state === "running" ? await serviceState(status.port) : null;
        return {
          project_id: project.project_id,
          state: status.state,
          ...(state
            ? {
                cdp: state.cdp,
                driver: state.driver,
                ask: state.ask,
                tabs: state.tabs,
                active: state.active,
                agents: state.agents,
                viewers: state.viewers,
              }
            : {}),
        };
      });
    });

  browser
    .command("stop")
    .description("stop the shared browser (the profile is deleted)")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "project browser stop", async (ctx: any) => {
        const { project, api } = await resolveProjectProjectApi(
          ctx,
          opts.project,
        );
        await api.apps.stopApp(SHARED_BROWSER_APP_ID);
        return { project_id: project.project_id, stopped: true };
      });
    });

  browser
    .command("ask-human")
    .description(
      "ask the human to take over the shared browser (e.g. to log in), shown in the card; with --wait, return once they hand back",
    )
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--message <text>", "what you need the human to do")
    .option("--wait", "wait until the human has taken over and handed back")
    .option("--timeout <minutes>", "give up waiting after this long", "30")
    .action(async (opts: any, command: Command) => {
      await withContext(
        command,
        "project browser ask-human",
        async (ctx: any) => {
          const { status } = await running(ctx, opts.project);
          if (status.state !== "running" || !status.port)
            throw Error(
              "the shared browser is not running; run `cocalc project browser start`",
            );
          let state = await post(status.port, "/api/ask", {
            message: opts.message,
          });
          if (!opts.wait) return { asked: true, driver: state.driver };
          const deadline = Date.now() + Number(opts.timeout) * 60_000;
          let tookOver = state.driver === "human";
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            state = (await serviceState(status.port)) ?? state;
            if (state.driver === "human") tookOver = true;
            else if (tookOver)
              return { asked: true, handed_back: true, tabs: state.tabs };
          }
          throw Error(
            "timed out waiting for the human to take over and hand back",
          );
        },
      );
    });
}
