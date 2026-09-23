import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { mountArg } from "@cocalc/backend/podman";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import {
  getImageNamePath,
  mount,
  unmount,
} from "@cocalc/project-runner/run/rootfs";
import { getEnvironment } from "@cocalc/project-runner/run/env";
import { getCoCalcMounts } from "@cocalc/project-runner/run/mounts";
import {
  podmanRuntimeArgs,
  projectPoolPodmanLauncher,
  projectSecretsHostPath,
  forceKillContainerProcesses,
} from "@cocalc/project-runner/run/podman";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_GID,
} from "@cocalc/util/project-runtime";
import {
  ensureProjectContainerRunning,
  createProjectCliTokenLease,
  applyProjectRuntimeCliEnv,
  resolveProjectRuntimeApiUrl,
} from "../codex/codex-project";
import { PROJECT_SECRETS_MOUNT_PATH } from "@cocalc/util/project-secrets-constants";
import { getProject } from "../sqlite/projects";
import getLogger from "@cocalc/backend/logger";
import { harnessOwner, HARNESS_OWNER_LABEL } from "./harness-reaper";
import { createAnthropicAccountCredentialRelay } from "./anthropic-credential-relay";
import type { CredentialHttpRelay } from "./credential-http-relay";

const logger = getLogger("project-host:acp:harness-launcher");

const QUALIFIED_HARNESS_ENTRY = "/opt/cocalc/acp/qualified-harness-entry.js";
const QUALIFIED_HARNESS_HOST_ENTRY =
  process.env.COCALC_QUALIFIED_HARNESS_ENTRY ??
  join(__dirname, "..", "qualified-harness", "index.js");
const CREDENTIAL_RELAY_MOUNT = "/run/cocalc/credential-relay";

export function resolveHarnessCommand(
  profile: ReturnType<typeof parseAcpHarnessProfile>,
  credentialMode?: "project-secret" | "account-api-key",
): { executable: string; args: string[] } {
  if (profile.version === 1) {
    return { executable: profile.executable, args: [...profile.args] };
  }
  const candidate = getQualifiedHarnessCandidate(profile.id);
  if (
    !candidate ||
    candidate.status === "disabled" ||
    candidate.package.version !== profile.revision
  ) {
    throw Error("Qualified ACP harness is not available");
  }
  return {
    executable: "/opt/cocalc/bin/node",
    args: [
      QUALIFIED_HARNESS_ENTRY,
      candidate.id,
      candidate.package.version,
      credentialMode ?? "project-secret",
    ],
  };
}

/** Internal worker launcher. Admission must authorize the principal before calling. */
export async function launchHarnessInProject(
  binding: HarnessBinding,
  conversation: { path: string; threadId: string },
): Promise<HarnessProcess> {
  const { projectId, accountId } = binding;
  const path = conversation?.path;
  const threadId = conversation?.threadId;
  const profile = parseAcpHarnessProfile(binding.profile);
  const credential = binding.credential;
  const harnessCommand = resolveHarnessCommand(
    profile,
    credential.mode === "account-api-key" ? credential.mode : undefined,
  );
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    !getProject(projectId)
  )
    throw Error("ACP project is not available on this host");
  if (
    typeof path !== "string" ||
    !path ||
    typeof threadId !== "string" ||
    !threadId
  )
    throw Error("ACP launch requires an admitted conversation");
  await ensureProjectContainerRunning({ projectId, accountId });
  const owner = await harnessOwner();
  const launcher = projectPoolPodmanLauncher(projectId);
  // Never log arguments: image/project-managed configuration may contain secrets.
  const command = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.argsPrefix, ...args],
        {
          cwd: "/",
          env: podmanEnv(),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, _stdout, stderr) => {
          if (!error) return resolve();
          const stopTimeout =
            args[0] === "rm" &&
            (error.killed ||
              /given PID did not die within timeout/.test(`${stderr}`));
          reject(
            Object.assign(Error("ACP container operation failed"), {
              code: stopTimeout ? "ACP_CONTAINER_STOP_TIMEOUT" : undefined,
            }),
          );
        },
      );
    });
  const { home, scratch } = await localPath({ project_id: projectId });
  const image = (await readFile(getImageNamePath(home), "utf8")).trim();
  const env = await getEnvironment({
    project_id: projectId,
    HOME: DEFAULT_PROJECT_RUNTIME_HOME,
    image,
  });
  const rootfs = await mount({
    project_id: projectId,
    home,
    config: { image },
  });
  const name = `acp-${projectId}-${randomUUID()}`;
  let created = false;
  let stopped: Promise<void> | undefined;
  let cliLease: Awaited<ReturnType<typeof createProjectCliTokenLease>>;
  let credentialRelay: CredentialHttpRelay | undefined;
  let credentialRelayDirectory: string | undefined;
  const cleanup = () =>
    (stopped ??= (async () => {
      // Keep the rootfs lease if removal fails; never unmount beneath a live child.
      try {
        if (created) {
          const remove = () =>
            command(["rm", "--ignore", "--force", "--time", "0", name]);
          try {
            await remove();
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !==
              "ACP_CONTAINER_STOP_TIMEOUT"
            )
              throw error;
            // Same bounded Podman-hang recovery used by project stop. Target only
            // this generated sidecar, never the primary project container.
            await forceKillContainerProcesses(projectId, name);
            await remove();
          }
        }
      } finally {
        // Revoke scoped authority even if a failed runtime removal needs repair.
        await cliLease?.close();
        await credentialRelay?.close();
        if (credentialRelayDirectory)
          await rm(credentialRelayDirectory, { recursive: true, force: true });
      }
      await unmount(projectId);
    })().catch((error) => {
      stopped = undefined;
      throw error;
    }));
  try {
    // Only service-created context may select a run identity. Never inherit a
    // token or identity file from the image environment or launch profile.
    const identityContext = {
      COCALC_CODEX_CHAT_PATH: path,
      COCALC_CODEX_THREAD_ID: threadId,
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
        path,
        threadId,
      ]),
      currentEnv: identityContext,
    });
    if (!cliLease) throw Error("Scoped ACP CLI credentials unavailable");
    for (const key of [
      "COCALC_BEARER_TOKEN",
      "COCALC_AGENT_TOKEN",
      "COCALC_AGENT_IDENTITY_FILE",
      "COCALC_AGENT_MENTION_REFERENCES_FILE",
    ])
      delete env[key];
    Object.assign(env, identityContext, {
      COCALC_BEARER_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_TOKEN_FILE: cliLease.containerPath,
      COCALC_API_URL: resolveProjectRuntimeApiUrl(),
    });
    if (cliLease.identityContainerPath)
      env.COCALC_AGENT_IDENTITY_FILE = cliLease.identityContainerPath;
    applyProjectRuntimeCliEnv(env, accountId);
    if (credential.mode === "account-api-key") {
      if (
        profile.version !== 2 ||
        profile.id !== "claude-code" ||
        credential.provider !== "anthropic"
      ) {
        throw Error("Unsupported account credential binding");
      }
      credentialRelayDirectory = await mkdtemp(
        join(tmpdir(), "cocalc-acp-credential-"),
      );
      credentialRelay = await createAnthropicAccountCredentialRelay({
        projectId,
        accountId,
        credentialId: credential.credentialId,
        socketPath: join(credentialRelayDirectory, "relay.sock"),
      });
      await writeFile(
        join(credentialRelayDirectory, "token"),
        credentialRelay.token,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    const args = [
      "create",
      ...(await podmanRuntimeArgs()),
      "--cgroups=disabled",
      "--interactive",
      "--name",
      name,
      "--label",
      "cocalc.runtime=acp",
      "--label",
      `${HARNESS_OWNER_LABEL}=${owner}`,
      "--label",
      `cocalc.project=${projectId}`,
      `--userns=keep-id:uid=${DEFAULT_PROJECT_RUNTIME_UID},gid=${DEFAULT_PROJECT_RUNTIME_GID}`,
      "--user",
      `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
      // Preserve the project's existing network policy, not a new unrestricted network.
      `--network=container:project-${projectId}`,
      "--workdir",
      profile.cwd,
      mountArg({ source: home, target: DEFAULT_PROJECT_RUNTIME_HOME }),
      mountArg({
        source: projectSecretsHostPath(projectId),
        target: PROJECT_SECRETS_MOUNT_PATH,
        readOnly: true,
      }),
    ];
    if (scratch) args.push(mountArg({ source: scratch, target: "/tmp" }));
    if (credentialRelayDirectory) {
      args.push(
        mountArg({
          source: credentialRelayDirectory,
          target: CREDENTIAL_RELAY_MOUNT,
          readOnly: true,
        }),
      );
    }
    if (profile.version === 2) {
      args.push(
        mountArg({
          source: QUALIFIED_HARNESS_HOST_ENTRY,
          target: QUALIFIED_HARNESS_ENTRY,
          readOnly: true,
        }),
      );
    }
    for (const [source, target] of Object.entries(getCoCalcMounts()))
      args.push(mountArg({ source, target, readOnly: true }));
    for (const [key, value] of Object.entries(env))
      args.push("--env", `${key}=${value}`);
    args.push(
      "--rootfs",
      rootfs,
      harnessCommand.executable,
      ...harnessCommand.args,
    );
    // Mark before awaiting: timeout/disconnect can leave a successfully created container.
    created = true;
    await command(args);
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, "start", "--attach", "--interactive", name],
      {
        cwd: "/",
        env: podmanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = new Promise<void>((resolve) => {
      proc.once("close", resolve);
      proc.once("error", resolve);
    });
    // Process exit also terminates surviving children in the isolated PID namespace.
    void closed.then(cleanup).catch(() => {
      logger.warn("ACP container cleanup failed", { projectId, name });
    });
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      closed,
      stop: async () => {
        await cleanup();
        proc.kill("SIGKILL");
        await closed;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
