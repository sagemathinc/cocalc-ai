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
(design: src/.agents/claude-subscription-in-project-2026-11-06.md).

What project code can do while a session is open is use that session, as
with the account API-key relay; never obtain the token.
*/

import { spawn, execFile } from "node:child_process";
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

const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
// Looks like a setup token, so Claude Code takes the OAuth path; it is only
// this session's relay token.
const RELAY_TOKEN_PREFIX = "sk-ant-oat01-cocalc-";
// The real token is revalidated at most this often (revocation lag).
const CREDENTIAL_RECHECK_MS = 60_000;
const ADAPTER_ENTRY = `${CLAUDE_CODE_INSTALL_ROOT}/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
const PROJECT_SKILL = "/opt/cocalc/project-bundle/skills/cocalc";
const STOP_GRACE_MS = 3_000;

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

/**
 * The command run in the project container: put the CoCalc skill where
 * Claude Code looks (unless the project has its own), record the adapter's
 * pid so stop can end its process tree, then run the ACP adapter.
 */
export function claudeInProjectScript(pidFile: string): string {
  return [
    'skills="$HOME/.claude/skills"',
    'mkdir -p "$skills" 2>/dev/null',
    // An empty directory is a stale mount point from the old sidecar.
    `if [ ! -e "$skills/cocalc/SKILL.md" ]; then rmdir "$skills/cocalc" 2>/dev/null; [ -e "$skills/cocalc" ] || [ -L "$skills/cocalc" ] || ln -s ${PROJECT_SKILL} "$skills/cocalc" 2>/dev/null; fi`,
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN",
    `echo $$ > ${pidFile}`,
    `exec /opt/cocalc/bin/node ${ADAPTER_ENTRY}`,
  ].join("\n");
}

/**
 * Ends the adapter and everything it started (Claude Code, its shells and
 * MCP servers): TERM to the whole tree, then KILL. The tree comes from
 * /proc, which every project image has, and only if the recorded pid is
 * still the adapter. Everything runs as the project user, so the worst a
 * project can do by editing the pid file is stop its own processes.
 */
export function claudeInProjectStopScript(pidFile: string): string {
  return [
    `p=$(cat ${pidFile} 2>/dev/null) || exit 0`,
    `rm -f ${pidFile}`,
    'case "$p" in ""|*[!0-9]*) exit 0;; esac',
    `tr '\\000' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q claude-agent-acp || exit 0`,
    'ppids=$(for d in /proc/[0-9]*; do while IFS=": \t" read -r k v; do if [ "$k" = PPid ]; then echo "${d#/proc/} $v"; break; fi; done 2>/dev/null < "$d/status"; done)',
    'tree() { echo "$1"; for c in $(echo "$ppids" | while read -r a b; do [ "$b" = "$1" ] && echo "$a"; done); do tree "$c"; done; }',
    'pids=$(tree "$p")',
    "kill -TERM $pids 2>/dev/null",
    "sleep 2",
    "kill -KILL $pids 2>/dev/null",
    "exit 0",
  ].join("\n");
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
    allowedMethods: ["GET", "POST"],
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
      NO_PROXY: "localhost,127.0.0.1,::1,host.containers.internal",
      no_proxy: "localhost,127.0.0.1,::1,host.containers.internal",
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

    const pidFile = `/tmp/.cocalc-claude-${randomUUID()}.pid`;
    const name = `project-${projectId}`;
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
    const launcher = projectPoolPodmanLauncher(projectId);
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, ...execArgs],
      {
        cwd: "/",
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = new Promise<void>((resolve) => {
      proc.once("close", () => resolve());
      proc.once("error", () => resolve());
    });
    const lease = cliLease;
    let released: Promise<void> | undefined;
    const release = () =>
      (released ??= (async () => {
        relay.close();
        await lease.close().catch(() => {});
      })());
    void closed.then(release);
    const stopInContainer = () =>
      new Promise<void>((resolve) => {
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
            claudeInProjectStopScript(pidFile),
          ],
          { cwd: "/", env: spawnEnv, timeout: 15_000, killSignal: "SIGKILL" },
          () => resolve(),
        );
      });
    let stopping: Promise<void> | undefined;
    return {
      // Not the controller: a normal session in the project's cwd.
      sessionPolicy: "default",
      subscriptionAuth: "oauth-token",
      beginConnectorTurn: (chat) => lease.beginConnectorTurn(chat),
      endConnectorTurn: () => lease.endConnectorTurn(),
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      closed,
      stop: () =>
        (stopping ??= (async () => {
          try {
            // Ending the podman exec client would not end the process in
            // the container: end the adapter's tree there, then the client.
            await stopInContainer();
            proc.stdin.end();
            await Promise.race([
              closed,
              new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
            ]);
          } finally {
            proc.kill("SIGKILL");
            await closed;
            await release();
          }
        })()),
    };
  } catch (error) {
    relay.close();
    await cliLease?.close().catch(() => {});
    throw error;
  }
}
