/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
A Claude subscription agent run in the project, like Codex: Claude Code is
`podman exec`'d into the project's own container as the project user, so it
and everything it starts are ordinary project processes (visible in ps/top,
using the project's MCP servers, skills and settings in ~/.claude).

The subscription token never enters the project. Claude Code gets
CLAUDE_CODE_OAUTH_TOKEN set to a per-session relay token and
ANTHROPIC_BASE_URL set to the host's project-reachable provider proxy
(site-funded-proxy.ts), which swaps in the real token on each model request.
With non-essential traffic off, model requests are all Claude Code sends
(design: "Running in the project" in
src/.agents/claude-subscription-support-plan-2026-09-23.md).

What project code can do while a session is open is use that session, as
with the account API-key relay; never obtain the token. That includes the
project's other collaborators: the user is to be warned before any turn in a
project with other collaborators.
*/

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import getLogger from "@cocalc/backend/logger";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
import {
  CLAUDE_CODE_INSTALL_ROOT,
  getQualifiedHarnessCandidate,
} from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { projectPoolPodmanLauncher } from "@cocalc/project-runner/run/podman";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
} from "@cocalc/util/project-runtime";
import {
  applyProjectRuntimeCliEnv,
  createProjectCliTokenLease,
  ensureProjectContainerRunning,
  pushPodmanEnv,
  resolveProjectRuntimeApiUrl,
} from "../codex/codex-project";
import { startProviderRelaySession } from "../codex/site-funded-proxy";
import {
  copyBeneath,
  kindBeneath,
  listBeneath,
  mkdirBeneath,
  renameBeneath,
  rmBeneath,
} from "../beneath-copy";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { claudeSubscriptionToken } from "./claude-subscription-token";

const logger = getLogger("project-host:acp:claude-subscription-in-project");

const RELAY_NO_PROXY = "localhost,127.0.0.1,::1,host.containers.internal";

/**
 * Settings env pinned at Claude Code's flag-settings tier for every session
 * (HarnessProcess.pinnedSettingsEnv): settings files the project's users can
 * write (~/.claude, the project's .claude) can neither send model requests
 * anywhere but the relay, directly or through a proxy, nor turn on telemetry
 * or other non-essential traffic. The token itself is not pinned: a settings
 * file that swaps it only reaches the relay, which refuses any other bearer.
 */
export function claudeRelaySettingsEnv(
  baseUrl: string,
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    NO_PROXY: RELAY_NO_PROXY,
    no_proxy: RELAY_NO_PROXY,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  };
}

const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
// Looks like a setup token, so Claude Code takes the OAuth path; it is only
// this session's relay token.
const RELAY_TOKEN_PREFIX = "sk-ant-oat01-cocalc-";
// The real token is revalidated at most this often (revocation lag).
const CREDENTIAL_RECHECK_MS = 60_000;
const ADAPTER_ENTRY = `${CLAUDE_CODE_INSTALL_ROOT}/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
const PROJECT_SKILL = "/opt/cocalc/project-bundle/skills/cocalc";
const STOP_GRACE_MS = 3_000;
// The start time (field 22) of a process, from one read of /proc/<pid>/stat.
// The comm field may hold spaces and parentheses: count from the last ")".
const START_TIME_FN =
  'st() { s=$(cat /proc/$1/stat 2>/dev/null) || return 1; set -- ${s##*) }; echo "${20}"; }';

export type ClaudeSubscriptionRuntime = "controller" | "project";

let runtimeCache: { at: number; value: ClaudeSubscriptionRuntime } | undefined;

/**
 * The site's claude_subscription_runtime, cached briefly. Anything unclear is
 * the controller, the existing path.
 */
export async function claudeSubscriptionRuntime(
  getCustomize?: (fields: string[]) => Promise<any>,
  now = Date.now(),
): Promise<ClaudeSubscriptionRuntime> {
  if (runtimeCache && now - runtimeCache.at < 60_000) return runtimeCache.value;
  let value: ClaudeSubscriptionRuntime = "controller";
  try {
    getCustomize ??= (await import("@cocalc/lite/hub/api")).hubApi.system
      ?.getCustomize;
    const customize = await getCustomize?.(["claudeSubscriptionRuntime"]);
    if (customize?.claudeSubscriptionRuntime === "project") value = "project";
  } catch {
    return "controller";
  }
  runtimeCache = { at: now, value };
  return value;
}

/** For tests. */
export function resetClaudeSubscriptionRuntimeCache(): void {
  runtimeCache = undefined;
}

/** Claude Code's directory name under ~/.claude/projects for a cwd. */
export function claudeProjectsKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Before resuming `sessionId` in the project, make sure Claude Code finds it
 * in ~/.claude/projects/<cwd key>/. Sessions started by the subscription
 * controller live in .local/share/cocalc/claude-sessions/<account>/<tree>/
 * -workspace/ (the controller's cwd was /workspace): copy that session's
 * transcript and its own directory once. Never follows a symlink.
 */
export async function migrateClaudeSession({
  projectHome,
  accountId,
  sessionId,
  cwd,
}: {
  projectHome: string;
  accountId: string;
  sessionId: string;
  /** The session's cwd in the project container. */
  cwd: string;
}): Promise<"present" | "migrated" | "missing"> {
  if (!isValidUUID(accountId) || !isValidUUID(sessionId))
    throw Error("Invalid Claude session");
  const target = [".claude", "projects", claudeProjectsKey(cwd)].join("/");
  const transcript = `${target}/${sessionId}.jsonl`;
  const present = await kindBeneath(projectHome, transcript);
  if (present === "file") return "present";
  if (present !== "missing") throw Error("Unsafe Claude transcript file");
  const base = [".local", "share", "cocalc", "claude-sessions", accountId].join(
    "/",
  );
  if ((await kindBeneath(projectHome, base)) !== "dir") return "missing";
  const matches: string[] = [];
  for (const name of await listBeneath(projectHome, base)) {
    if (!isValidUUID(name)) continue;
    const old = `${base}/${name}/-workspace/${sessionId}.jsonl`;
    if ((await kindBeneath(projectHome, old)) === "file") matches.push(name);
  }
  if (matches.length === 0) return "missing";
  if (matches.length > 1)
    throw Error(
      `Ambiguous Claude transcript session ${sessionId}: it exists under several subscriptions in ${base}. Keep the intended one and move the others out, then retry.`,
    );
  const from = `${base}/${matches[0]}/-workspace`;
  mkdirBeneath(projectHome, ".claude", 0o700);
  mkdirBeneath(projectHome, ".claude/projects", 0o700);
  mkdirBeneath(projectHome, target, 0o700);
  // The session's own directory (subagents, tool results) first, then the
  // transcript, which is renamed into place last: once it is there, the
  // session counts as moved and is Claude Code's.
  if ((await kindBeneath(projectHome, `${from}/${sessionId}`)) === "dir")
    await copyBeneath({
      src: { root: projectHome, path: `${from}/${sessionId}` },
      dest: { root: projectHome, path: `${target}/${sessionId}` },
      options: { recursive: true, preserveTimestamps: true },
    });
  const partial = `${transcript}.cocalc-partial`;
  await rmBeneath(projectHome, partial);
  await copyBeneath({
    src: { root: projectHome, path: `${from}/${sessionId}.jsonl` },
    dest: { root: projectHome, path: partial },
    options: { preserveTimestamps: true },
  });
  renameBeneath(projectHome, partial, transcript, { noReplace: true });
  return "migrated";
}

/** Where Claude Code reads its local managed (admin) policy on Linux. */
const MANAGED_POLICY_ROOT = "/etc/claude-code";
/** The exit status of the managed-policy check when a policy is present. */
export const MANAGED_POLICY_EXIT = 78;
export const MANAGED_POLICY_MESSAGE =
  "This project's image contains Claude Code managed settings (/etc/claude-code), which take precedence over the settings CoCalc uses to keep a Claude subscription's requests on its relay. Remove /etc/claude-code from the project to use a Claude subscription here.";

/**
 * Exits with MANAGED_POLICY_EXIT when the container has Claude Code's
 * managed policy directory: its managed-settings.json, managed-settings.d
 * and managed-mcp.json outrank the relay route pinned in the session's flag
 * settings. Anything at that path counts (an empty directory, a file, a
 * symlink, broken or not), so no file under it, present or future, is
 * missed; nothing is read or followed.
 */
export function claudeManagedPolicyCheck(
  root: string = MANAGED_POLICY_ROOT,
): string {
  return `if [ -e ${root} ] || [ -L ${root} ]; then exit ${MANAGED_POLICY_EXIT}; fi`;
}

/**
 * The command run in the project container: refuse a managed policy, put
 * the CoCalc skill where Claude Code looks (unless the project has its own),
 * record the adapter's pid so stop can end its process tree, then run the
 * ACP adapter.
 */
export function claudeInProjectScript(
  pidFile: string,
  managedPolicyRoot: string = MANAGED_POLICY_ROOT,
): string {
  return [
    // checked again here, right before the adapter reads managed policy
    claudeManagedPolicyCheck(managedPolicyRoot),
    'skills="$HOME/.claude/skills"',
    'mkdir -p "$skills" 2>/dev/null',
    // An empty directory is a stale mount point from the old sidecar.
    `if [ ! -e "$skills/cocalc/SKILL.md" ]; then rmdir "$skills/cocalc" 2>/dev/null; [ -e "$skills/cocalc" ] || [ -L "$skills/cocalc" ] || ln -s ${PROJECT_SKILL} "$skills/cocalc" 2>/dev/null; fi`,
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN",
    // policy locations and overrides only an administrator may choose
    "unset CLAUDE_CODE_MANAGED_SETTINGS_PATH CLAUDE_CODE_REMOTE_SETTINGS_PATH CLAUDE_CODE_MOCK_REMOTE_SETTINGS CLAUDE_CODE_MANAGED_CONFIG_PREFETCH",
    // The adapter's identity: its pid and start time (exec keeps both).
    START_TIME_FN,
    `echo "$$ $(st $$)" > ${pidFile}`,
    `exec /opt/cocalc/bin/node ${ADAPTER_ENTRY}`,
  ].join("\n");
}

// One read of every process's /proc/<pid>/stat: "pid ppid start comm" per
// line (the parent and start time together, so no other process can be
// mistaken for a child). comm, which may hold spaces, comes last.
const SNAPSHOT =
  'snap=$(for d in /proc/[0-9]*; do s=$(cat "$d/stat" 2>/dev/null) || continue; c=${s#*\\(}; c=${c%\\)*}; set -- ${s##*) }; echo "${d#/proc/} $2 ${20} $c"; done)';
// Every descendant of a process, as pid:start.
const TREE_FN =
  'tree() { echo "$snap" | while read -r a b c n; do [ "$b" = "$1" ] && echo "$a:$c" && tree "$a"; done; }';
// The agent's own descendants: all but the shells it started for commands
// and whatever runs under them (its jobs, in the foreground or background).
const AGENT_FN =
  'agent() { echo "$snap" | while read -r a b c n; do [ "$b" = "$1" ] || continue; case "$n" in sh|bash|dash|zsh|ash|ksh|fish) continue;; esac; echo "$a:$c"; agent "$a"; done; }';
// The recorded adapter, still the same process: else exit.
const ADAPTER_CHECK = (pidFile: string, remove: boolean) => [
  `read -r p t < ${pidFile} 2>/dev/null || exit 0`,
  ...(remove ? [`rm -f ${pidFile}`] : []),
  'case "$p$t" in ""|*[!0-9]*) exit 0;; esac',
  START_TIME_FN,
  '[ "$(st "$p")" = "$t" ] || exit 0',
  `tr '\\000' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q claude-agent-acp || exit 0`,
];

/**
 * Stops the agent: the adapter, Claude Code and what it runs itself (MCP
 * servers), TERM then KILL. With `jobs`, everything it started too: the
 * shells running its commands and their children. Without, those are left
 * running: a job the agent started outlives it, as Codex's do. Every
 * process is known by its pid and start time, never its pid alone, so a pid
 * freed and reused by another process is never signaled:
 * - the adapter by the pid and start time it recorded at launch;
 * - the tree from one read of each /proc/<pid>/stat;
 * - each signal only while that start time still matches.
 * Everything runs as the project user, so the worst a project can do by
 * editing the pid file is stop its own processes.
 */
export function claudeInProjectStopScript(
  pidFile: string,
  { jobs = true }: { jobs?: boolean } = {},
): string {
  return [
    ...ADAPTER_CHECK(pidFile, true),
    SNAPSHOT,
    jobs ? TREE_FN : AGENT_FN,
    `procs="$p:$t $(${jobs ? "tree" : "agent"} "$p")"`,
    // The adapter is still the one recorded: its children are its own.
    '[ "$(st "$p")" = "$t" ] || exit 0',
    'signal() { for e in $procs; do [ "$(st "${e%%:*}")" = "${e#*:}" ] && kill -"$1" "${e%%:*}" 2>/dev/null; done; true; }',
    "signal TERM",
    "sleep 2",
    "signal KILL",
    "exit 0",
  ].join("\n");
}

/** The environment variable marking every process of one agent run. */
export const AGENT_RUN_ENV = "COCALC_AGENT_RUN";

/**
 * Prints "busy" while a process the agent started in a shell is running,
 * else "idle". Such processes carry the run's marker in their environment
 * (inherited from the adapter), so a job is found even after the shell that
 * started it exited and it was reparented; the agent's own processes do not
 * count.
 */
export function claudeInProjectBackgroundWorkScript(
  pidFile: string,
  runId: string,
): string {
  return [
    "idle() { echo idle; exit 0; }",
    ...ADAPTER_CHECK(pidFile, false).map((line) =>
      line.replace(/exit 0$/, "idle"),
    ),
    SNAPSHOT,
    AGENT_FN,
    "own=\" $p $(agent \"$p\" | sed 's/:.*//' | tr '\\n' ' ') \"",
    "for d in /proc/[0-9]*; do",
    "  q=${d#/proc/}",
    '  case "$own" in *" $q "*) continue;; esac',
    `  tr '\\000' '\\n' < "$d/environ" 2>/dev/null | grep -qxF "${AGENT_RUN_ENV}=${runId}" && { echo busy; exit 0; }`,
    "done",
    "idle",
  ].join("\n");
}

/** Runs claudeManagedPolicyCheck in the project container. */
async function checkNoManagedPolicy(
  launcher: { command: string; argsPrefix: string[] },
  name: string,
): Promise<void> {
  const code = await new Promise<number | string | null>((resolve) =>
    execFile(
      launcher.command,
      [
        ...launcher.argsPrefix,
        "exec",
        "-u",
        `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
        name,
        "/bin/sh",
        "-c",
        claudeManagedPolicyCheck(),
      ],
      { cwd: "/", timeout: 15_000, killSignal: "SIGKILL" },
      (error) => resolve(error ? ((error as any).code ?? "failed") : 0),
    ),
  );
  if (code === MANAGED_POLICY_EXIT) throw Error(MANAGED_POLICY_MESSAGE);
  if (code !== 0)
    throw Error(
      "Could not check the project for Claude Code managed settings; try again.",
    );
}

/**
 * The lifecycle of the podman exec client running the adapter. Its
 * credentials (the relay session and the CLI lease) are released once, by
 * whichever comes first: the client's exit, a spawn error, stop(), or (as a
 * fallback) the close of its stdio. Release never waits for stdio to close:
 * a job the agent started can keep the client's stdout and stderr open long
 * after the agent itself is gone, and its credentials must not outlive the
 * agent. `closed` resolves at close or error, or a grace period after exit
 * when the stdio stays open; stop() returns within a bounded time.
 */
export function superviseInProjectProcess({
  proc,
  release,
  stopInContainer,
  graceMs = STOP_GRACE_MS,
}: {
  proc: Pick<ChildProcess, "once" | "kill"> & {
    stdin: { end: () => unknown } | null;
  };
  release: () => Promise<void>;
  stopInContainer: () => Promise<void>;
  graceMs?: number;
}): { closed: Promise<void>; stop: () => Promise<void> } {
  let released: Promise<void> | undefined;
  const releaseOnce = () =>
    (released ??= (async () => {
      try {
        await release();
      } catch (err) {
        logger.warn("releasing in-project Claude credentials failed", {
          err: `${err}`,
        });
      }
    })());
  const delay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.());
  const closed = new Promise<void>((resolve) => {
    proc.once("close", () => {
      void releaseOnce();
      resolve();
    });
    proc.once("error", () => {
      void releaseOnce();
      resolve();
    });
    proc.once("exit", () => {
      void releaseOnce();
      void delay().then(resolve);
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // credentials first: nothing below may keep them live
      const releasing = releaseOnce();
      try {
        // Ending the podman exec client would not end the process in the
        // container: end the adapter's tree there, then the client.
        await stopInContainer();
        proc.stdin?.end();
        await Promise.race([closed, delay()]);
      } catch (err) {
        logger.warn("stopping in-project Claude failed", { err: `${err}` });
      } finally {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await releasing;
        await Promise.race([closed, delay()]);
      }
    })());
  return { closed, stop };
}

export async function launchClaudeSubscriptionInProject(
  binding: HarnessBinding,
  conversation: { path: string; threadId: string; sessionId?: string },
): Promise<HarnessProcess> {
  const { projectId, accountId, credential } = binding;
  const profile = parseAcpHarnessProfile(binding.profile);
  const candidate = getQualifiedHarnessCandidate("claude-code");
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    credential.mode !== "account-subscription" ||
    credential.provider !== "anthropic" ||
    profile.version !== 2 ||
    profile.id !== "claude-code" ||
    candidate?.package.version !== profile.revision
  )
    throw Error("Unsupported Claude subscription profile");
  if (
    typeof conversation?.path !== "string" ||
    !conversation.path ||
    typeof conversation.threadId !== "string" ||
    !conversation.threadId
  )
    throw Error("ACP launch requires an admitted conversation");
  const credentialId = credential.credentialId;
  const tokenOf = async () => {
    const registered = await getClaudeSubscriptionCredential({
      projectId,
      accountId,
      credentialId,
    });
    const token = claudeSubscriptionToken(registered.payload);
    if (!token)
      throw Error(
        "This Claude subscription uses an older sign-in that is no longer supported. Reconnect it in Claude settings.",
      );
    return token;
  };
  // Fail now, with a clear message, rather than at the first request.
  let token = await tokenOf();
  let checkedAt = Date.now();

  await ensureProjectContainerRunning({ projectId, accountId });
  const name = `project-${projectId}`;
  const launcher = projectPoolPodmanLauncher(projectId);
  // A managed policy in the container would outrank the relay route pinned
  // in the session's settings: refuse before any credential exists. The
  // launch script checks again right before the adapter starts.
  await checkNoManagedPolicy(launcher, name);
  const { home, scratch } = await localPath({ project_id: projectId });
  if (conversation.sessionId) {
    const migrated = await migrateClaudeSession({
      projectHome: home,
      accountId,
      sessionId: conversation.sessionId,
      cwd: profile.cwd,
    });
    if (migrated === "migrated")
      logger.info("Claude session moved into ~/.claude", {
        projectId,
        sessionId: conversation.sessionId,
      });
  }

  const relay = await startProviderRelaySession({
    upstream: ANTHROPIC_API_ORIGIN,
    allowedPathPrefix: "/v1/",
    // Only the model endpoints Claude Code uses, as sent (S1)
    allowedPaths: ["/v1/messages", "/v1/messages/count_tokens"],
    allowedMethods: ["POST"],
    credentialHeader: "authorization",
    credentialValue: async () => {
      if (Date.now() - checkedAt > CREDENTIAL_RECHECK_MS) {
        token = await tokenOf();
        checkedAt = Date.now();
      }
      return `Bearer ${token}`;
    },
    tokenPrefix: RELAY_TOKEN_PREFIX,
  });

  let cliLease: Awaited<ReturnType<typeof createProjectCliTokenLease>>;
  try {
    const identityContext = {
      COCALC_CODEX_CHAT_PATH: conversation.path,
      COCALC_CODEX_THREAD_ID: conversation.threadId,
    };
    cliLease = await createProjectCliTokenLease({
      projectId,
      accountId,
      home,
      scratch,
      agentSessionKey: JSON.stringify([
        "acp",
        projectId,
        accountId,
        conversation.path,
        conversation.threadId,
      ]),
      currentEnv: identityContext,
    });
    if (!cliLease) throw Error("Scoped ACP CLI credentials unavailable");
    const env: Record<string, string> = {
      ...identityContext,
      HOME: DEFAULT_PROJECT_RUNTIME_HOME,
      USER: "user",
      LOGNAME: "user",
      LANG: "C.UTF-8",
      NO_BROWSER: "1",
      // The relay session: not the subscription token.
      CLAUDE_CODE_OAUTH_TOKEN: relay.token,
      ANTHROPIC_BASE_URL: relay.baseUrl,
      // Only model requests, all through the relay: no telemetry, bootstrap,
      // MCP registry or claude.ai connectors (which an inference-only token
      // cannot use anyway).
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // CoCalc agent memory is these sessions' memory.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      NO_PROXY: RELAY_NO_PROXY,
      no_proxy: RELAY_NO_PROXY,
      COCALC_BEARER_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_TOKEN_FILE: cliLease.containerPath,
      COCALC_API_URL: resolveProjectRuntimeApiUrl(),
    };
    if (cliLease.identityContainerPath)
      env.COCALC_AGENT_IDENTITY_FILE = cliLease.identityContainerPath;
    if (cliLease.connectorContainerPath)
      env.COCALC_CONNECTOR_API_KEY_FILE = cliLease.connectorContainerPath;
    applyProjectRuntimeCliEnv(env, accountId);
    if (cliLease.connectorContainerPath) cliLease.applyCliConnectorEnv(env);

    // This run: its pid file, and the marker every process it starts inherits
    const runId = randomUUID();
    env[AGENT_RUN_ENV] = runId;
    const pidFile = `/tmp/.cocalc-claude-${runId}.pid`;
    const execArgs = [
      "exec",
      "-i",
      "-u",
      `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
      "--workdir",
      profile.cwd,
    ];
    // Values of credential-like names go by name only (pushPodmanEnv).
    const spawnEnv = pushPodmanEnv(execArgs, env);
    execArgs.push(name, "/bin/sh", "-c", claudeInProjectScript(pidFile));
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, ...execArgs],
      {
        cwd: "/",
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lease = cliLease;
    const inContainer = (script: string) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          launcher.command,
          [
            ...launcher.argsPrefix,
            "exec",
            "-u",
            `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
            name,
            "/bin/sh",
            "-c",
            script,
          ],
          { cwd: "/", timeout: 15_000, killSignal: "SIGKILL" },
          (error, stdout) => (error ? reject(error) : resolve(`${stdout}`)),
        );
      });
    // Between turns the agent's jobs outlive it; during a turn, a command
    // still running is the turn's own, and is stopped with it.
    let inTurn = false;
    const stopInContainer = async () => {
      await inContainer(
        claudeInProjectStopScript(pidFile, { jobs: inTurn }),
      ).catch(() => {});
    };
    const { closed, stop } = superviseInProjectProcess({
      proc,
      release: async () => {
        relay.close();
        await lease.close().catch(() => {});
      },
      stopInContainer,
    });
    return {
      // Not the controller: a normal session in the project's cwd.
      sessionPolicy: "default",
      pinnedSettingsEnv: claudeRelaySettingsEnv(relay.baseUrl),
      subscriptionAuth: "oauth-token",
      // The harness calls these around every turn of the qualified Claude
      // Code harness (endConnectorTurn in its finally): a turn makes the
      // relay session usable, and its end starts the fixed time after which
      // the session is suspended until the next turn (B2).
      beginConnectorTurn: async (chat) => {
        // A managed policy added since the start (an install run with sudo,
        // say) fails the turn before the relay accepts it.
        await checkNoManagedPolicy(launcher, name);
        relay.beginTurn();
        inTurn = true;
        try {
          return await lease.beginConnectorTurn(chat);
        } catch (error) {
          // the harness ends only turns that began
          inTurn = false;
          relay.endTurn();
          throw error;
        }
      },
      endConnectorTurn: async () => {
        try {
          await lease.endConnectorTurn();
        } finally {
          inTurn = false;
          relay.endTurn();
        }
      },
      hasBackgroundWork: async () =>
        (
          await inContainer(claudeInProjectBackgroundWorkScript(pidFile, runId))
        ).trim() === "busy",
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      closed,
      stop,
    };
  } catch (error) {
    relay.close();
    await cliLease?.close().catch(() => {});
    throw error;
  }
}
