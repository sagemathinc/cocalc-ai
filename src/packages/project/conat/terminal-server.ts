import { terminalServer, type Options } from "@cocalc/conat/project/terminal";
import { spawn } from "node-pty";
import { getIdentity } from "./connection";
import { getLogger } from "@cocalc/project/logger";
import { SpoolWatcher } from "@cocalc/backend/spool-watcher";
import { data } from "@cocalc/backend/data";
import { project_id } from "@cocalc/project/data";
import { randomId } from "@cocalc/conat/names";
import { join } from "path";
import { debounce } from "lodash";
import { getOwnedProcessRegistry } from "@cocalc/project/project-info";
import { supportsTerminalCwdLookup, terminalCwdForPid } from "./terminal/cwd";
import { console_init_filename, path_split } from "@cocalc/util/misc";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { projectRuntimePathForProcess } from "@cocalc/util/project-runtime";
import { getProjectHubApi } from "./hub";
import { normalizeSiteUrl, projectScopedCliEnv } from "../project-cli-env";

export { projectScopedCliEnv };

const logger = getLogger("project:conat:terminal-server");

export function init(opts) {
  opts = getIdentity(opts);
  logger.debug("init");
  terminalServer({
    ...opts,
    spawn,
    cwd: terminalCwdForPid,
    preHook,
    postHook,
  });
}

function supportsTerminalInitFile(command?: string): boolean {
  return typeof command === "string" && command.endsWith("bash");
}

export function normalizeTerminalCommand(
  hook: { command?: string; args?: string[] },
  {
    platform = process.platform,
    env = process.env,
  }: {
    platform?: NodeJS.Platform;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): void {
  if (platform !== "win32") return;
  const command = `${hook.command ?? ""}`.trim();
  const isDefaultBash =
    command === "" ||
    ((command === "bash" || command.endsWith("/bash")) &&
      (hook.args?.length ?? 0) === 0);
  if (!isDefaultBash) return;
  hook.command =
    `${env.COCALC_WINDOWS_TERMINAL_SHELL ?? ""}`.trim() || "powershell.exe";
  hook.args = ["-NoLogo"];
}

let resolvedSiteUrl: string | undefined;
let siteUrlRequest: Promise<string | undefined> | undefined;

async function requestProjectSiteUrl(): Promise<string | undefined> {
  const fromEnv = normalizeSiteUrl(process.env.COCALC_SITE_URL);
  if (fromEnv) return fromEnv;
  if (resolvedSiteUrl) return resolvedSiteUrl;
  if (!siteUrlRequest) {
    siteUrlRequest = getProjectHubApi()
      .system.getPublicSiteUrl({ project_id })
      .then(({ url }) => {
        resolvedSiteUrl = normalizeSiteUrl(url);
        if (resolvedSiteUrl) {
          process.env.COCALC_SITE_URL = resolvedSiteUrl;
        }
        return resolvedSiteUrl;
      })
      .catch((err) => {
        logger.debug("unable to resolve public CoCalc site URL", {
          err: `${err}`,
        });
        return undefined;
      })
      .finally(() => {
        siteUrlRequest = undefined;
      });
  }
  return await Promise.race([
    siteUrlRequest,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 2_000),
    ),
  ]);
}

export function applyTerminalRuntimeCwd(
  options: Options,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  options.cwd = projectRuntimePathForProcess(options.cwd, env);
}

export async function applyTerminalInitFile({
  command,
  args,
  options,
}: {
  command?: string;
  args?: string[];
  options: Options;
}): Promise<{
  args: string[] | undefined;
  initFilename?: string;
  hasTerminalInitFile: boolean;
}> {
  if (!supportsTerminalInitFile(command) || !options?.id) {
    return {
      args,
      hasTerminalInitFile: false,
    };
  }
  const initFilename = console_init_filename(options.id);
  const hasTerminalInitFile = await exists(initFilename);
  if (!hasTerminalInitFile) {
    return {
      args,
      initFilename,
      hasTerminalInitFile,
    };
  }
  const nextArgs = [...(args ?? [])];
  nextArgs.push("--init-file");
  nextArgs.push(path_split(initFilename).tail);
  return {
    args: nextArgs,
    initFilename,
    hasTerminalInitFile,
  };
}

async function preHook(hook: {
  command?: string;
  args?: string[];
  options: Options;
}) {
  normalizeTerminalCommand(hook);
  const { command, args, options } = hook;
  applyTerminalRuntimeCwd(options);
  await requestProjectSiteUrl();
  options.env0 = {
    ...projectScopedCliEnv(),
    ...(options.env0 ?? {}),
  };
  if (options.env0) {
    for (const key in options.env0) {
      options.env0[key] = options.env0[key].replace(
        /\$HOME/g,
        process.env.HOME ?? "",
      );
    }
  }
  if (options.env0?.COCALC_CONTROL_DIR != null) {
    options.env0.COCALC_CONTROL_DIR = join(data, "terminal", randomId());
  }
  const {
    args: nextArgs,
    initFilename,
    hasTerminalInitFile,
  } = await applyTerminalInitFile({
    command,
    args,
    options,
  });
  hook.args = nextArgs;
  logger.debug("terminal spawn preHook", {
    id: options?.id,
    path: options?.path,
    cwd: options?.cwd,
    command,
    args: nextArgs,
    initFilename,
    hasTerminalInitFile,
  });
  // terminalServer preHook mutates the passed object in place.
  // Returning a value here is ignored.
}

async function postHook({ options, pty }) {
  const registry = getOwnedProcessRegistry();
  const root = registry.registerRoot({
    kind: "terminal",
    path: options?.path,
    session_id: options?.id,
  });
  if (pty?.pid != null) {
    registry.attachPid(root.root_id, pty.pid);
  }
  pty.once("exit", () => {
    registry.markExited(root.root_id, { pid: pty?.pid });
    registry.removeRoot(root.root_id);
  });

  const spoolDir = options?.env?.COCALC_CONTROL_DIR;
  if (!spoolDir) {
    return;
  }
  const messageSpool = new SpoolWatcher(spoolDir, async (payload) => {
    pty.emit("broadcast", "user-command", payload);
  });
  pty.once("exit", () => {
    messageSpool.close();
  });
  await messageSpool.start();

  if (supportsTerminalCwdLookup() && process.env.HOME != null) {
    let cur: string | undefined = "";
    pty.on(
      "data",
      debounce(
        async () => {
          try {
            const c = await terminalCwdForPid(pty.pid);
            if (c != cur) {
              cur = c;
              pty.emit("broadcast", "update-cwd", cur);
            }
          } catch {}
        },
        250,
        { leading: true, trailing: true },
      ),
    );
  }
}
