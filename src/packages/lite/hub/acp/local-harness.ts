/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Claude Code (and project-configured ACP agents) in CoCalc Plus: the harness
runs as an ordinary local process in the agent's working directory, like
Codex does there (codex-runtime.ts). No containers, relays or sidecars: on a
single-user computer it is just a program the user runs.

Claude Code is the ACP adapter (@agentclientprotocol/claude-agent-acp, plain
JavaScript, shipped with CoCalc Plus) driving the user's own installed
`claude`, signed in the way it is in their terminal (~/.claude or
ANTHROPIC_API_KEY).
*/

import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import getLogger from "@cocalc/backend/logger";
import type { HarnessProcess } from "@cocalc/ai/acp/harness";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import type { AcpHarnessProfile } from "@cocalc/util/ai/runtime";
import { getHarnessLauncher, setHarnessLauncher } from "./harness-runtime";
import type { HarnessLaunchFactory } from "./harness-runtime";

const logger = getLogger("lite:hub:acp:local-harness");

const ADAPTER_ENTRY = path.join(
  "node_modules",
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist",
  "index.js",
);

export const CLAUDE_INSTALL_HELP =
  "Claude Code is not installed on this computer. Install it (see https://code.claude.com/docs/en/setup, for example `curl -fsSL https://claude.ai/install.sh | bash`), sign in by running `claude` once in a terminal, then try again. If it is installed somewhere unusual, set COCALC_CLAUDE_BIN to its path.";

const ADAPTER_MISSING =
  "This CoCalc Plus installation does not include the Claude Code adapter. Reinstall CoCalc Plus, or set COCALC_CLAUDE_AGENT_ACP to the adapter's dist/index.js.";

/** The ACP adapter's entry point: an explicit path, the copy shipped next to
 * the CoCalc Plus bundle, or (in development) the managed tools install. */
export function resolveClaudeAdapterEntry({
  env = process.env,
  entryPoint = process.env.COCALC_LITE_DAEMON_ENTRYPOINT ?? process.argv[1],
  exists = existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  entryPoint?: string;
  exists?: (file: string) => boolean;
} = {}): string {
  const explicit = `${env.COCALC_CLAUDE_AGENT_ACP ?? ""}`.trim();
  if (explicit) {
    if (!exists(explicit))
      throw Error(`COCALC_CLAUDE_AGENT_ACP does not exist: ${explicit}`);
    return explicit;
  }
  const candidates: string[] = [];
  if (entryPoint)
    candidates.push(
      path.join(path.dirname(entryPoint), "claude-agent-acp", ADAPTER_ENTRY),
    );
  candidates.push(path.join("/opt/cocalc/bin2/claude-code/app", ADAPTER_ENTRY));
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) throw Error(ADAPTER_MISSING);
  return found;
}

function isExecutableFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The user's own `claude`: COCALC_CLAUDE_BIN, PATH, then the places the
 * upstream installers put it. Undefined when it is not installed. */
export function resolveClaudeExecutable({
  env = process.env,
  platform = process.platform,
  home = env.COCALC_ORIGINAL_HOME || homedir(),
  isFile = isExecutableFile,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: (file: string) => boolean;
} = {}): string | undefined {
  const explicit = `${env.COCALC_CLAUDE_BIN ?? ""}`.trim();
  if (explicit) return isFile(explicit) ? explicit : undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = `${env.PATH ?? ""}`
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  dirs.push(
    pathApi.join(home, ".local", "bin"),
    pathApi.join(home, ".claude", "local"),
    ...(platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
  );
  for (const dir of dirs)
    for (const name of names) {
      const file = pathApi.join(dir, name);
      if (isFile(file)) return file;
    }
  return undefined;
}

/** The Claude Code version the adapter's Agent SDK was built against. */
export function adapterClaudeCodeVersion(
  adapterEntry: string,
): string | undefined {
  // .../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
  const modules = path.resolve(adapterEntry, "..", "..", "..", "..");
  try {
    const sdk = JSON.parse(
      readFileSync(
        path.join(modules, "@anthropic-ai", "claude-agent-sdk", "package.json"),
        "utf8",
      ),
    );
    return typeof sdk.claudeCodeVersion === "string"
      ? sdk.claudeCodeVersion
      : undefined;
  } catch {
    return undefined;
  }
}

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [+match[1], +match[2], +match[3]] : undefined;
}

/**
 * Any installed version is used (never refused); one outside the qualified
 * range (the same major.minor as the SDK's pin, and not older than it) is
 * reported, since the adapter may then misbehave.
 */
export function claudeVersionWarning(
  installed: string | undefined,
  expected: string | undefined,
): string | undefined {
  const have = installed ? parseVersion(installed) : undefined;
  const want = expected ? parseVersion(expected) : undefined;
  if (!want) return undefined;
  if (!have)
    return `Could not determine the installed Claude Code version; CoCalc Plus is tested with ${expected}.`;
  const older =
    have[0] < want[0] ||
    (have[0] === want[0] &&
      (have[1] < want[1] || (have[1] === want[1] && have[2] < want[2])));
  if (have[0] !== want[0] || have[1] !== want[1] || older)
    return `The installed Claude Code is version ${have.join(".")}; CoCalc Plus is tested with ${want[0]}.${want[1]}.x from ${expected}. If something does not work, update it with \`claude update\`.`;
  return undefined;
}

const versionCache = new Map<string, Promise<string | undefined>>();

function installedClaudeVersion(executable: string): Promise<string | undefined> {
  let mtime = 0;
  try {
    mtime = statSync(executable).mtimeMs;
  } catch {}
  const key = `${executable}\0${mtime}`;
  let version = versionCache.get(key);
  if (!version) {
    version = new Promise((resolve) =>
      execFile(executable, ["--version"], { timeout: 15_000 }, (error, out) =>
        resolve(error ? undefined : `${out}`.trim().split("\n")[0]),
      ),
    );
    versionCache.set(key, version);
  }
  return version;
}

type LocalCommand = { executable: string; args: string[]; env: NodeJS.ProcessEnv };

/** What to run for a harness profile and credential, without starting it. */
export async function resolveLocalHarnessCommand(
  profile: AcpHarnessProfile,
  credentialMode: string,
  {
    env = process.env,
    adapterEntry = () => resolveClaudeAdapterEntry({ env }),
    claudeExecutable = () => resolveClaudeExecutable({ env }),
    claudeVersion = installedClaudeVersion,
  }: {
    env?: NodeJS.ProcessEnv;
    adapterEntry?: () => string;
    claudeExecutable?: () => string | undefined;
    claudeVersion?: (executable: string) => Promise<string | undefined>;
  } = {},
): Promise<LocalCommand & { warning?: string }> {
  if (profile.version === 1) {
    if (credentialMode !== "project-managed")
      throw Error("This ACP harness does not support account credentials");
    return { executable: profile.executable, args: [...profile.args], env: {} };
  }
  if (profile.id !== CLAUDE_CODE_QUALIFICATION.id)
    throw Error("Unsupported qualified ACP harness");
  // Lite has one credential: this computer's own Claude Code sign-in, which
  // the turn selects as its project credential.
  if (credentialMode !== "project-secret")
    throw Error(
      "CoCalc Plus runs Claude Code with this computer's own Claude Code sign-in; other Claude credentials are not available here yet.",
    );
  const entry = adapterEntry();
  const claude = claudeExecutable();
  if (!claude) throw Error(CLAUDE_INSTALL_HELP);
  const installed = await claudeVersion(claude);
  const warning = claudeVersionWarning(
    installed,
    adapterClaudeCodeVersion(entry),
  );
  logger.info("Claude Code", { claude, version: installed, adapter: entry });
  if (warning) logger.warn(warning);
  return {
    executable: process.execPath,
    // No --hide-claude-auth: on the user's own computer, their own Claude
    // Code login (a Claude subscription or a key) is exactly what is used.
    args: [entry],
    env: {
      CLAUDE_CODE_EXECUTABLE: claude,
      // Under the Bun build of CoCalc Plus, execPath is the CoCalc Plus
      // binary; this makes it run the script as Bun would.
      ...(process.versions.bun ? { BUN_BE_BUN: "1" } : {}),
    },
    ...(warning ? { warning } : {}),
  };
}

const IDENTITY_ENV_KEYS = [
  "COCALC_AGENT_IDENTITY_FILE",
  "COCALC_AGENT_MENTION_REFERENCES_FILE",
  "COCALC_CODEX_MESSAGE_DATE",
  "COCALC_CODEX_TURN_ID",
  "COCALC_BROWSER_ID",
];

/** The harness's environment: the user's own (as in their terminal) plus the
 * CoCalc CLI context of this conversation. */
export function localHarnessEnv({
  base = process.env,
  projectId,
  accountId,
  path: chatPath,
  threadId,
  extra,
}: {
  base?: NodeJS.ProcessEnv;
  projectId: string;
  accountId: string;
  path: string;
  threadId: string;
  extra: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of IDENTITY_ENV_KEYS) delete env[key];
  if (base.COCALC_ORIGINAL_HOME) env.HOME = base.COCALC_ORIGINAL_HOME;
  Object.assign(env, extra, {
    COCALC_PROJECT_ID: projectId,
    COCALC_ACCOUNT_ID: accountId,
    COCALC_CODEX_CHAT_PATH: chatPath,
    COCALC_CODEX_THREAD_ID: threadId,
    COCALC_CLI_AGENT_MODE: "1",
  });
  return env;
}

/** Ends the harness and everything it started (its shell commands too). */
function terminateTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", `${pid}`, "/T", "/F"], () => {});
    return;
  }
  try {
    // Negative: the whole process group (spawned detached, so it leads one).
    // Never the bare pid: after the harness exits it may belong to another.
    process.kill(-pid, signal);
  } catch {}
}

export const launchLocalHarness: HarnessLaunchFactory = async (
  binding,
  conversation,
): Promise<HarnessProcess> => {
  const { profile } = binding;
  if (!conversation?.path || !conversation.threadId)
    throw Error("ACP launch requires an admitted conversation");
  if (!existsSync(profile.cwd))
    throw Error(`The agent's working directory does not exist: ${profile.cwd}`);
  const command = await resolveLocalHarnessCommand(
    profile,
    binding.credential.mode,
  );
  const child = spawn(command.executable, command.args, {
    cwd: profile.cwd,
    env: localHarnessEnv({
      projectId: binding.projectId,
      accountId: binding.accountId,
      path: conversation.path,
      threadId: conversation.threadId,
      extra: command.env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", (error) => {
      logger.warn("local ACP harness failed to start", `${error}`);
      resolve();
    });
  });
  let exited = false;
  void closed.then(() => {
    exited = true;
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    closed,
    stop: async () => {
      if (!exited) {
        terminateTree(child.pid, "SIGTERM");
        const timer = setTimeout(
          () => terminateTree(child.pid, "SIGKILL"),
          5_000,
        );
        await closed;
        clearTimeout(timer);
      }
      // Commands the agent left running in the background share the group.
      terminateTree(child.pid, "SIGKILL");
    },
  };
};

/** CoCalc Plus only: a project host installs its own container launcher. */
export function installLiteHarnessLauncher(): void {
  if (getHarnessLauncher()) return;
  setHarnessLauncher(launchLocalHarness);
}
