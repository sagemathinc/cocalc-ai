/**
 * `cocalc project browser start|status|stop|ask-human`: the shared browser
 * an agent drives over CDP while a human watches and can take over in a
 * chat card.  The browser itself runs as the project app `cocalc-browser`
 * (`cocalc project browser serve`).
 */
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SharedBrowserPage } from "../../core/shared-browser/agent-page";

import {
  findSharedBrowserChrome,
  SHARED_BROWSER_APP_ID,
} from "../../core/shared-browser/service";
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
        // Fail early with an install hint instead of a startup timeout.
        if (process.env.COCALC_PROJECT_ID === project.project_id)
          findSharedBrowserChrome(undefined);
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
            "Act on the page with `cocalc project browser goto|text|click|type|press|eval|screenshot`, or connect any CDP client to `cdp` (e.g. Playwright chromium.connectOverCDP(cdp) and use its existing context and page). While the human has taken over, page actions wait until they hand back. To ask the human to take over (logins, CAPTCHAs): cocalc project browser ask-human --message '...' --wait",
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

  // Built-in page actions for agents without a CDP client library.
  const onPage = async <T>(
    ctx: any,
    project: string | undefined,
    fn: (page: SharedBrowserPage) => Promise<T>,
  ): Promise<T> => {
    const { status } = await running(ctx, project);
    const state =
      status.state === "running" ? await serviceState(status.port) : null;
    if (!state)
      throw Error(
        "the shared browser is not running here; run `cocalc project browser start` in the project first",
      );
    if (state.driver === "human")
      console.error(
        "The human is driving the shared browser; waiting until they hand back...",
      );
    const page = await SharedBrowserPage.open(state.cdp, state.active);
    try {
      return await fn(page);
    } finally {
      page.close();
    }
  };
  const pageCommand = (name: string, description: string) =>
    browser
      .command(name)
      .description(description)
      .option("-w, --project <project>", "project id or name");

  pageCommand(
    "goto <url>",
    "open a URL (or host, or search words) in the shared browser's current tab and wait for it to load",
  ).action(async (url: string, opts: any, command: Command) => {
    await withContext(command, "project browser goto", (ctx: any) =>
      onPage(ctx, opts.project, (page) => page.goto(url)),
    );
  });

  pageCommand("text", "print the current tab's URL, title and visible text")
    .option(
      "--max <chars>",
      "truncate the text to this many characters",
      "20000",
    )
    .action(async (opts: any, command: Command) => {
      await withContext(command, "project browser text", (ctx: any) =>
        onPage(ctx, opts.project, (page) => page.text(Number(opts.max))),
      );
    });

  pageCommand(
    "eval [expression]",
    "evaluate JavaScript in the current tab (promises are awaited) and print the JSON result",
  )
    .option("--stdin", "read the expression from stdin")
    .action(
      async (expression: string | undefined, opts: any, command: Command) => {
        await withContext(command, "project browser eval", async (ctx: any) => {
          let code = expression;
          if (opts.stdin) {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin)
              chunks.push(Buffer.from(chunk));
            code = Buffer.concat(chunks).toString("utf8");
          }
          if (!code?.trim())
            throw Error("an expression or --stdin is required");
          return await onPage(ctx, opts.project, async (page) => ({
            value: (await page.evaluate(code!)) ?? null,
          }));
        });
      },
    );

  pageCommand(
    "click <selector>",
    "click the element matching a CSS selector with the mouse",
  ).action(async (selector: string, opts: any, command: Command) => {
    await withContext(command, "project browser click", (ctx: any) =>
      onPage(ctx, opts.project, (page) => page.click(selector)),
    );
  });

  pageCommand(
    "type <text>",
    "type text into the focused element (or --selector after focusing it)",
  )
    .option("--selector <css>", "focus this element first")
    .action(async (text: string, opts: any, command: Command) => {
      await withContext(command, "project browser type", (ctx: any) =>
        onPage(ctx, opts.project, async (page) => {
          await page.type(text, opts.selector);
          return { typed: text.length };
        }),
      );
    });

  pageCommand(
    "press <key>",
    "press one key: a character, Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp or PageDown",
  ).action(async (key: string, opts: any, command: Command) => {
    await withContext(command, "project browser press", (ctx: any) =>
      onPage(ctx, opts.project, (page) => page.press(key)),
    );
  });

  pageCommand("screenshot", "save a PNG of the current tab")
    .option("--out <path>", "where to save it (default: a new file in /tmp)")
    .option("--full-page", "the whole page, not just the visible part")
    .action(async (opts: any, command: Command) => {
      await withContext(
        command,
        "project browser screenshot",
        async (ctx: any) => {
          const out = resolve(
            opts.out ?? join(tmpdir(), `cocalc-browser-${Date.now()}.png`),
          );
          return await onPage(ctx, opts.project, async (page) => {
            await writeFile(out, await page.screenshot(!!opts.fullPage));
            return { path: out, ...(await page.location()) };
          });
        },
      );
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
