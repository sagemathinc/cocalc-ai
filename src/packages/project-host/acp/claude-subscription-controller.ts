/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { CLAUDE_PROJECT_MCP_NAME } from "./claude-project-tool-source";
import { CLAUDE_PROJECT_JOB_GUIDANCE } from "@cocalc/util/ai/claude-project-tools";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { mountArg } from "@cocalc/backend/podman";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { normalizeRootfsImageName } from "@cocalc/util/rootfs-images";
import { CLAUDE_CODE_INSTALL_ROOT } from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { getNodeRuntimeMounts } from "@cocalc/project-runner/run/mounts";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import {
  forceKillContainerProcesses,
  podmanRuntimeArgs,
  projectPoolPodmanLauncher,
} from "@cocalc/project-runner/run/podman";
import { extractBaseImage } from "@cocalc/project-runner/run/rootfs-base";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { restoreClaudeSubscriptionHome } from "./claude-subscription-home";
import { claudeSubscriptionToken } from "./claude-subscription-token";
import { createClaudeCredentialSync } from "./claude-credential-sync";
import {
  CLAUDE_PROJECT_TOOL_MOUNT,
  createClaudeProjectToolBridge,
  type ClaudeProjectToolBridge,
} from "./claude-project-tool-bridge";
import {
  applyProjectRuntimeCliEnv,
  createProjectCliTokenLease,
  ensureProjectContainerRunning,
  getBuiltinClaudeSkillText,
  resolveProjectRuntimeApiUrl,
} from "../codex/codex-project";
import { harnessOwner, HARNESS_OWNER_LABEL } from "./harness-reaper";
import {
  projectHostAddress,
  projectNeedsRestrictedClaudeEgress,
  startClaudeRestrictedEgress,
  type ClaudeRestrictedEgress,
} from "./claude-restricted-egress";
import {
  CLAUDE_CONTROLLER_HOME_LABEL,
  claudeControllerHomePrefix,
} from "./claude-subscription-paths";

const CONTROLLER_HOME = "/home/claude";
const CONTROLLER_WORKSPACE = "/workspace";
const MANAGED_HARNESSES = "/opt/cocalc/harnesses";
const logger = getLogger("project-host:acp:claude-subscription-controller");

// Project startup normalizes image references before caching them. Use the
// same cache key or a first Claude turn unnecessarily pulls the base image.
export const CLAUDE_CONTROLLER_BASE_IMAGE = normalizeRootfsImageName(
  DEFAULT_PROJECT_IMAGE,
);

export async function ensureClaudeTranscriptDirectory(options: {
  projectHome: string;
  accountId: string;
  credentialId: string;
  sessionId?: string;
}): Promise<string> {
  const { projectHome, accountId, credentialId, sessionId } = options;
  if (!isValidUUID(accountId) || !isValidUUID(credentialId))
    throw Error("Invalid Claude transcript owner");
  if (sessionId && !isValidUUID(sessionId))
    throw Error("Invalid Claude transcript session");
  let directory = projectHome;
  for (const part of [
    ".local",
    "share",
    "cocalc",
    "claude-sessions",
    accountId,
  ]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Unsafe Claude transcript directory");
  }
  // Credentials authorize inference, not ownership of saved context. Reconnect
  // can issue a new credential ID; locate only the admitted session under the
  // same CoCalc owner and project. Keep its original tree (including fork and
  // subagent context) in place rather than copying or merging transcript data.
  if (sessionId) {
    const matches: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!isValidUUID(entry.name)) continue;
      const candidate = join(directory, entry.name);
      let missing = false;
      for (const path of [candidate, join(candidate, "-workspace")]) {
        const stat = await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!stat) {
          missing = true;
          break;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error("Unsafe Claude transcript directory");
      }
      if (missing) continue;
      const transcript = await lstat(
        join(candidate, "-workspace", `${sessionId}.jsonl`),
      ).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!transcript) continue;
      if (!transcript.isFile() || transcript.isSymbolicLink())
        throw Error("Unsafe Claude transcript file");
      matches.push(candidate);
    }
    if (matches.length > 1)
      throw Error(
        `Ambiguous Claude transcript session ${sessionId}; original data preserved. ` +
          "Back up these files, then keep the intended session in place and move the other copies out of the Claude transcript directories before retrying. Matching files (host path; path relative to project home):\n" +
          matches
            .map((path) => {
              const file = join(path, "-workspace", `${sessionId}.jsonl`);
              return `${JSON.stringify(file)}; ${JSON.stringify(relative(projectHome, file))}`;
            })
            .sort()
            .join("\n"),
      );
    if (matches.length === 1) return matches[0];
  }
  const current = join(directory, credentialId);
  await mkdir(current, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Unsafe Claude transcript directory");
  return current;
}

export async function cleanupClaudeSubscriptionController(options: {
  stopContainer: () => Promise<void>;
  closeBridge: () => Promise<void>;
  refreshCredential: () => Promise<void>;
  removeHome: () => Promise<void>;
  launched: boolean;
}): Promise<void> {
  // Revoke command authority even when Podman cannot confirm removal.
  let bridgeError: unknown;
  try {
    await options.closeBridge();
  } catch (error) {
    bridgeError = error;
  }
  await options.stopContainer();
  try {
    if (options.launched) await options.refreshCredential();
  } finally {
    await options.removeHome();
  }
  if (bridgeError) throw bridgeError;
}

export function claudeSubscriptionContainerArgs(options: {
  name: string;
  projectId: string;
  owner: string;
  home: string;
  rootfs: string;
  managedHarnesses: string;
  nodeMounts: Record<string, string>;
  toolBridgeDirectory?: string;
  sessionDirectory?: string;
  uid: number;
  gid: number;
  runtimeArgs?: string[];
  claudeAiConnectors?: boolean;
  // Extra environment, e.g. the restricted egress proxy.
  env?: Record<string, string>;
  // Private host file with secret environment (the subscription token), so
  // the secret never appears in podman's command line.
  envFile?: string;
}): string[] {
  const {
    name,
    projectId,
    owner,
    home,
    rootfs,
    managedHarnesses,
    nodeMounts,
    toolBridgeDirectory,
    sessionDirectory,
    uid,
    gid,
    runtimeArgs = [],
  } = options;
  const entry = `${CLAUDE_CODE_INSTALL_ROOT}/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
  return [
    "create",
    ...runtimeArgs,
    "--name",
    name,
    "--label",
    "cocalc.runtime=acp",
    "--label",
    `${HARNESS_OWNER_LABEL}=${owner}`,
    "--label",
    `cocalc.project=${projectId}`,
    "--label",
    `${CLAUDE_CONTROLLER_HOME_LABEL}=${home}`,
    "--interactive",
    "--read-only",
    "--security-opt=no-new-privileges",
    "--cap-drop=all",
    "--pids-limit=128",
    "--network=slirp4netns",
    "--userns=keep-id",
    "--user",
    `${uid}:${gid}`,
    "--workdir",
    CONTROLLER_WORKSPACE,
    "--tmpfs",
    `${CONTROLLER_WORKSPACE}:mode=1777`,
    "--tmpfs",
    "/tmp:mode=1777",
    mountArg({ source: home, target: CONTROLLER_HOME }),
    ...(sessionDirectory
      ? [
          mountArg({
            source: sessionDirectory,
            target: `${CONTROLLER_HOME}/projects`,
          }),
        ]
      : []),
    mountArg({
      source: managedHarnesses,
      target: MANAGED_HARNESSES,
      readOnly: true,
    }),
    ...(toolBridgeDirectory
      ? [
          mountArg({
            source: toolBridgeDirectory,
            target: CLAUDE_PROJECT_TOOL_MOUNT,
            readOnly: true,
          }),
        ]
      : []),
    ...Object.entries(nodeMounts).map(([source, target]) =>
      // Host bootstrap gives Node a file capability for HTTPS. Ignore that
      // capability here so exec succeeds with the controller's empty cap set.
      mountArg({ source, target, readOnly: true, options: "nosuid" }),
    ),
    "--env",
    `HOME=${CONTROLLER_HOME}`,
    "--env",
    `CLAUDE_CONFIG_DIR=${CONTROLLER_HOME}`,
    "--env",
    `XDG_CONFIG_HOME=${CONTROLLER_HOME}`,
    "--env",
    "NO_BROWSER=1",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "PATH=/opt/cocalc/bin:/usr/bin:/bin",
    ...(options.claudeAiConnectors === false
      ? ["--env", "ENABLE_CLAUDEAI_MCP_SERVERS=false"]
      : []),
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    ...(options.envFile ? ["--env-file", options.envFile] : []),
    "--rootfs",
    // The shared image cache is immutable. Give OCI setup its own mount-point
    // layer; --read-only still prevents the controller from writing the rootfs.
    `${rootfs}:O`,
    "/opt/cocalc/bin/node",
    entry,
  ];
}

/** Credential-bearing controller: no project home, secrets, identity token or project network. */
export async function launchClaudeSubscriptionController(
  binding: HarnessBinding,
  conversation: { path: string; threadId: string; sessionId?: string },
): Promise<HarnessProcess> {
  const { projectId, accountId, credential } = binding;
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    credential.mode !== "account-subscription" ||
    credential.provider !== "anthropic"
  )
    throw Error("Invalid Claude subscription controller binding");
  if (
    typeof conversation?.path !== "string" ||
    !conversation.path ||
    typeof conversation.threadId !== "string" ||
    !conversation.threadId
  )
    throw Error("ACP launch requires an admitted conversation");
  const credentialId = credential.credentialId;
  const skill = await getBuiltinClaudeSkillText();
  const systemPromptAppend = `The CoCalc skill is preloaded below as session instructions, not as a separate Skill tool. Follow it for CoCalc workflows.
This is an isolated subscription controller. Run ALL project filesystem and CLI operations through the project_exec tool on ${CLAUDE_PROJECT_MCP_NAME}, not in the controller. Read applicable project CLAUDE.md instructions through that tool before editing. Skill reference files are available in the project at /home/user/.claude/skills/cocalc/.
Current project tool server: ${CLAUDE_PROJECT_MCP_NAME}.
${CLAUDE_PROJECT_JOB_GUIDANCE}
Use the exact installed CLI command: "/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js".
The project_exec environment contains the runtime-issued CoCalc agent identity for registered agents. Message other agents there, not in this isolated controller: \`"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" agent destinations\` lists who you can message and \`... agent send NAME --stdin\` sends one message (see the skill's Agent Messaging section and \`agent --help\`). Never substitute account credentials if agent identity or network access is unavailable.

<cocalc-skill>
${skill}
</cocalc-skill>`;
  const registered = await getClaudeSubscriptionCredential({
    projectId,
    accountId,
    credentialId,
  });
  // A long-lived token needs no home snapshot and is never written back.
  const token = claudeSubscriptionToken(registered.payload);
  // claude.ai connectors need a scope the inference-only token lacks.
  const claudeAiConnectors = token ? false : credential.claudeAiConnectors;
  await ensureProjectContainerRunning({ projectId, accountId });
  const rootfs = await extractBaseImage(CLAUDE_CONTROLLER_BASE_IMAGE);
  const home = await mkdtemp(claudeControllerHomePrefix());
  // Private to the host user, removed before the controller starts, and
  // reaped with the home if this process dies first.
  const envFile = join(home, ".cocalc-auth.env");
  const launcher = projectPoolPodmanLauncher(projectId);
  const name = `claude-controller-${projectId}-${randomUUID()}`;
  let created = false;
  let launched = false;
  let toolBridge: ClaudeProjectToolBridge | undefined;
  let cliLease: Awaited<ReturnType<typeof createProjectCliTokenLease>>;
  let restrictedEgress: ClaudeRestrictedEgress | undefined;
  let stopped: Promise<void> | undefined;
  let cleanupRetries = 0;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const credentialSync = token
    ? undefined
    : createClaudeCredentialSync({
        projectId,
        accountId,
        credentialId,
        home,
        restoredPayload: registered.payload,
      });
  const command = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.argsPrefix, ...args],
        {
          cwd: "/",
          env: podmanEnv(),
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
        (error) => {
          if (!error) return resolve();
          reject(
            Object.assign(Error("Claude controller operation failed"), {
              code: error.killed ? "CLAUDE_CONTROLLER_STOP_TIMEOUT" : undefined,
            }),
          );
        },
      );
    });
  const cleanup = () =>
    (stopped ??= cleanupClaudeSubscriptionController({
      stopContainer: async () => {
        if (!created) return;
        const remove = () =>
          command(["rm", "--ignore", "--force", "--time", "0", name]);
        try {
          await remove();
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !==
            "CLAUDE_CONTROLLER_STOP_TIMEOUT"
          )
            throw error;
          await forceKillContainerProcesses(projectId, name);
          await remove();
        }
      },
      closeBridge: async () => {
        restrictedEgress?.close();
        const results = await Promise.allSettled([
          toolBridge?.close(),
          cliLease?.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
      refreshCredential: async () => await credentialSync?.finish(),
      removeHome: async () => {
        await credentialSync?.idle();
        await rm(home, { recursive: true, force: true });
      },
      launched,
    })
      .then(() => {
        clearTimeout(cleanupTimer);
      })
      .catch((error) => {
        stopped = undefined;
        logger.warn("Claude controller cleanup failed", error);
        if (!cleanupTimer && cleanupRetries < 5) {
          cleanupRetries++;
          cleanupTimer = setTimeout(() => {
            cleanupTimer = undefined;
            void cleanup().catch(() => {});
          }, 5000);
          cleanupTimer.unref();
        }
        throw error;
      }));
  try {
    if (!token) await restoreClaudeSubscriptionHome(home, registered.payload);
    let sessionDirectory: string | undefined;
    // Resolve identity from the admitted conversation, never the subscription
    // or environment inherited by the credential-bearing controller.
    const identityContext = {
      COCALC_CODEX_CHAT_PATH: conversation!.path,
      COCALC_CODEX_THREAD_ID: conversation!.threadId,
    };
    const projectPaths = await localPath({ project_id: projectId });
    sessionDirectory = await ensureClaudeTranscriptDirectory({
      projectHome: projectPaths.home,
      accountId,
      credentialId,
      sessionId: conversation.sessionId,
    });
    cliLease = await createProjectCliTokenLease({
      projectId,
      accountId,
      agentSessionKey: JSON.stringify([
        "claude-subscription",
        projectId,
        accountId,
        credentialId,
        conversation!.path,
        conversation!.threadId,
      ]),
      currentEnv: identityContext,
      home: projectPaths.home,
      scratch: projectPaths.scratch,
    });
    if (!cliLease) throw Error("Scoped Claude CLI credentials unavailable");
    const cliEnv: Record<string, string> = {
      ...identityContext,
      COCALC_PROJECT_ID: projectId,
      COCALC_BEARER_TOKEN: "",
      COCALC_AGENT_TOKEN: "",
      COCALC_BEARER_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_IDENTITY_FILE: cliLease.identityContainerPath ?? "",
      COCALC_AGENT_MENTION_REFERENCES_FILE: "",
      // Holds the managed CoCalc connector key only during a turn whose
      // agent has the connector enabled.
      COCALC_CONNECTOR_API_KEY_FILE: cliLease.connectorContainerPath ?? "",
      COCALC_API_URL: resolveProjectRuntimeApiUrl(),
    };
    applyProjectRuntimeCliEnv(cliEnv, accountId);
    toolBridge = await createClaudeProjectToolBridge(
      projectId,
      async (script, cwd, signal, options) => {
        let result;
        try {
          result = await sandboxExec({
            project_id: projectId,
            script,
            cwd: cwd ?? binding.profile.cwd,
            env: cliEnv,
            signal,
            ...options,
          });
        } catch (error) {
          await cliLease?.close();
          throw error;
        }
        if (result.cleanupConfirmed !== true) {
          // Fence CLI authority independently of process/container cleanup.
          await cliLease?.close();
        }
        return result;
      },
      async () => {
        await getClaudeSubscriptionCredential({
          projectId,
          accountId,
          credentialId,
        });
      },
    );
    if (projectNeedsRestrictedClaudeEgress(projectId)) {
      // The controller runs in the project's network containment, which
      // blocks the internet but not the host's own addresses. Reach Anthropic
      // only through the host's allowlisting proxy.
      const host = projectHostAddress();
      if (!host)
        throw Error(
          "Claude cannot reach Anthropic: this project has no internet access and the project host address is unknown",
        );
      restrictedEgress = await startClaudeRestrictedEgress({
        projectId,
        host,
        claudeAiConnectors: claudeAiConnectors !== false,
      });
    }
    const owner = await harnessOwner();
    const managedHarnesses =
      process.env.COCALC_MANAGED_HARNESSES ?? MANAGED_HARNESSES;
    if (token)
      await writeFile(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    created = true;
    try {
      await command(
        claudeSubscriptionContainerArgs({
          name,
          projectId,
          owner,
          rootfs,
          home,
          managedHarnesses,
          nodeMounts: getNodeRuntimeMounts(),
          toolBridgeDirectory: toolBridge?.directory,
          claudeAiConnectors,
          sessionDirectory,
          uid: process.getuid!(),
          gid: process.getgid!(),
          runtimeArgs: await podmanRuntimeArgs(),
          env: restrictedEgress?.env,
          ...(token ? { envFile } : {}),
        }),
      );
    } finally {
      // Podman copied it into the container's configuration.
      await rm(envFile, { force: true });
    }
    launched = true;
    credentialSync?.start();
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, "start", "--attach", "--interactive", name],
      { cwd: "/", env: podmanEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => {
      proc.once("close", resolve);
      proc.once("error", resolve);
    });
    void closed
      .then(cleanup)
      .catch((error) =>
        logger.warn("Claude controller stopped without cleanup", error),
      );
    return {
      systemPromptAppend,
      projectToolServerName: CLAUDE_PROJECT_MCP_NAME,
      cancelTools: toolBridge ? () => toolBridge!.cancel() : undefined,
      resumeTools: toolBridge ? () => toolBridge!.resume() : undefined,
      setAsyncQuestionHandler: toolBridge
        ? (handler) => toolBridge!.setAsyncQuestionHandler(handler)
        : undefined,
      beginConnectorTurn: cliLease
        ? (chat) => cliLease!.beginConnectorTurn(chat)
        : undefined,
      endConnectorTurn: cliLease
        ? () => cliLease!.endConnectorTurn()
        : undefined,
      ...(token ? { subscriptionAuth: "oauth-token" as const } : {}),
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      closed,
      stop: async () => {
        try {
          await cleanup();
        } finally {
          proc.kill("SIGKILL");
          await closed;
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
