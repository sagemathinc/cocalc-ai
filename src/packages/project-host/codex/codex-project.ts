import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, isAbsolute } from "node:path";
import { URL } from "node:url";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { argsJoin } from "@cocalc/util/args";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import type {
  CodexAppServerLoginHint,
  CodexAppServerRequest,
  CodexAppServerRequestHandler,
} from "@cocalc/ai/acp";
import { setCodexProjectSpawner } from "@cocalc/ai/acp";
import { hubApi } from "@cocalc/lite/hub/api";
import { which } from "@cocalc/backend/which";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import {
  getImageNamePath,
  mount as mountRootFs,
  unmount,
} from "@cocalc/project-runner/run/rootfs";
import { networkArgument } from "@cocalc/project-runner/run/podman";
import { mountArg } from "@cocalc/backend/podman";
import { getEnvironment } from "@cocalc/project-runner/run/env";
import { getCoCalcMounts } from "@cocalc/project-runner/run/mounts";
import { getProject } from "../sqlite/projects";
import { touchProjectLastEdited } from "../last-edited";
import {
  type CodexAuthRuntime,
  logResolvedCodexAuthRuntime,
  redactCodexAuthRuntime,
  resolveCodexAuthRuntime,
  resolveSharedCodexHome,
} from "./codex-auth";
import { syncSubscriptionAuthToRegistryIfChanged } from "./codex-auth-registry";

const logger = getLogger("project-host:codex-project");
// Reusing long-lived Codex rootfs containers has proven flaky on some hosts:
// fresh containers work, then later turns can hang with broken networking.
// Keep the lease mechanism so a running turn keeps its container, but default
// to recreating the container as soon as the turn exits.
const CONTAINER_TTL_MS = Math.max(
  0,
  Number(process.env.COCALC_CODEX_PROJECT_TTL_MS ?? 0),
);
const CONTAINER_SETUP_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.COCALC_CODEX_CONTAINER_SETUP_TIMEOUT_MS ?? 30_000),
);
const PODMAN_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_PODMAN_TIMEOUT_MS ?? 45_000),
);
const PROJECT_START_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.COCALC_CODEX_PROJECT_START_TIMEOUT_MS ?? 90_000),
);
const PROJECT_START_POLL_MS = Math.max(
  100,
  Number(process.env.COCALC_CODEX_PROJECT_START_POLL_MS ?? 500),
);

type ContainerInfo = {
  name: string;
  rootfs: string;
  codexPath: string;
  home: string;
  scratch?: string;
};

type OptionalBindMount = {
  source: string;
  target: string;
  readOnly?: boolean;
};

const BUILTIN_LAUNCHPAD_SKILLS = ["cocalc"] as const;

const API_KEY_PROVIDER_ID = "cocalc-openai-api-key";
const API_KEY_PROVIDER_CONFIG = `model_providers.${API_KEY_PROVIDER_ID}={name="OpenAI",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses",requires_openai_auth=false}`;
const API_KEY_PROVIDER_SELECT = `model_provider="${API_KEY_PROVIDER_ID}"`;
const EPHEMERAL_AUTH_STORE_CONFIG = 'cli_auth_credentials_store="ephemeral"';
// Security-critical: app-server must be exec'd via the exact trusted Codex
// binary we installed into the project runtime image. Do not resolve this via
// PATH or any user-controlled fallback, since that could let a project replace
// the binary and capture site- or account-managed credentials. The override is
// intentionally named DANGEROUS because it is only for host-admin debugging.
function getProjectRuntimeCodexPath(): string {
  return (
    process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CODEX_PATH_OVERRIDE ??
    "/opt/cocalc/bin2/codex"
  );
}

function getProjectRuntimeCliPath(): string {
  return (
    process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CLI_PATH_OVERRIDE ??
    "/opt/cocalc/bin2/cocalc"
  );
}

function getProjectRuntimeCliCommand(): string {
  const override =
    `${process.env.COCALC_DANGEROUS_PROJECT_RUNTIME_CLI_CMD_OVERRIDE ?? ""}`.trim();
  if (override) return override;
  return '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"';
}

function isLoopbackHostname(hostname: string): boolean {
  const host = `${hostname ?? ""}`.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeApiUrl(
  raw: string,
  { rewriteLoopbackHost }: { rewriteLoopbackHost: boolean },
): string | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return;
  try {
    const parsed = new URL(trimmed);
    if (rewriteLoopbackHost && isLoopbackHostname(parsed.hostname)) {
      parsed.hostname = "host.containers.internal";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function normalizeProjectRuntimePath(pathValue?: string): string {
  const seen = new Set<string>();
  const ordered = [
    "/root/.local/bin",
    "/opt/cocalc/bin",
    "/opt/cocalc/bin2",
    "/opt/cocalc-cli/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    ...`${pathValue ?? ""}`
      .split(":")
      .map((part) => part.trim())
      .filter(Boolean),
  ];
  const normalized: string[] = [];
  for (const part of ordered) {
    if (seen.has(part)) continue;
    seen.add(part);
    normalized.push(part);
  }
  return normalized.join(":");
}

function applyProjectRuntimeCliEnv(
  env: Record<string, string>,
  accountId?: string,
): void {
  env.COCALC_CLI_BIN = getProjectRuntimeCliPath();
  env.COCALC_CLI_CMD = getProjectRuntimeCliCommand();
  if (accountId?.trim()) {
    env.COCALC_ACCOUNT_ID = accountId.trim();
  }
  env.PATH = normalizeProjectRuntimePath(env.PATH);
}

function resolveProjectRuntimeApiUrl(explicit?: string): string {
  const masterConat =
    `${process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER ?? ""}`.trim();
  const hostConfigured =
    `${process.env.COCALC_API_URL ?? process.env.BASE_URL ?? ""}`.trim();
  return (
    normalizeApiUrl(masterConat, { rewriteLoopbackHost: true }) ??
    normalizeApiUrl(hostConfigured, { rewriteLoopbackHost: true }) ??
    normalizeApiUrl(explicit ?? "", { rewriteLoopbackHost: true }) ??
    `http://host.containers.internal:${`${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`.trim() || "9100"}`
  );
}

function projectContainerName(projectId: string): string {
  return `project-${projectId}`;
}

function codexContainerName(projectId: string, contextId: string): string {
  return `codex-${projectId}-${contextId.slice(0, 12)}`;
}

function leaseKey(projectId: string, contextId: string): string {
  return `${projectId}:${contextId}`;
}

function parseLeaseKey(key: string): { projectId: string; contextId: string } {
  const i = key.indexOf(":");
  if (i === -1) {
    return { projectId: key, contextId: "shared-home" };
  }
  return { projectId: key.slice(0, i), contextId: key.slice(i + 1) };
}

function shouldForceEphemeralAppServerAuthStorage(
  authRuntime: CodexAuthRuntime,
): boolean {
  switch (authRuntime.source) {
    case "subscription":
    case "project-api-key":
    case "account-api-key":
    case "site-api-key":
      return true;
    case "shared-home":
      return false;
  }
}

function redactPodmanArgs(args: string[]): string {
  const redacted = [...args];
  for (let i = 0; i < redacted.length - 1; i++) {
    if (redacted[i] !== "-e") continue;
    const raw = redacted[i + 1];
    const j = raw.indexOf("=");
    if (j === -1) continue;
    const key = raw.slice(0, j);
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) {
      redacted[i + 1] = `${key}=***`;
    }
  }
  return argsJoin(redacted);
}

async function resolveProjectCliBearer({
  projectId,
  accountId,
  currentEnv,
}: {
  projectId: string;
  accountId?: string;
  currentEnv?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const existing =
    `${currentEnv?.COCALC_BEARER_TOKEN ?? ""}`.trim() ||
    `${currentEnv?.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (existing) return existing;
  const resolvedAccountId = `${accountId ?? ""}`.trim();
  if (!projectId.trim() || !resolvedAccountId) {
    return;
  }
  const issueAgentToken = hubApi.hosts?.issueProjectHostAgentAuthToken;
  if (typeof issueAgentToken !== "function") {
    return;
  }
  try {
    const issued = await issueAgentToken({
      account_id: resolvedAccountId,
      project_id: projectId,
    });
    const token = `${issued?.token ?? ""}`.trim();
    return token || undefined;
  } catch (err) {
    logger.debug("codex project: failed to issue project-host agent token", {
      projectId,
      accountId,
      err: `${err}`,
    });
    return;
  }
}

async function getOptionalCertMounts(): Promise<{
  mounts: OptionalBindMount[];
  env: Record<string, string>;
}> {
  // Codex device auth uses TLS calls to auth.openai.com. Some project rootfs
  // images are missing a CA bundle, so we bind host certs when available.
  const certDir = "/etc/ssl/certs";
  const certFile = join(certDir, "ca-certificates.crt");
  try {
    const [dirStat, fileStat] = await Promise.all([
      fs.stat(certDir),
      fs.stat(certFile),
    ]);
    if (dirStat.isDirectory() && fileStat.isFile()) {
      return {
        mounts: [{ source: certDir, target: certDir, readOnly: true }],
        env: {
          SSL_CERT_FILE: certFile,
          SSL_CERT_DIR: certDir,
        },
      };
    }
  } catch {
    // no host CA bundle found -- continue without extra mounts
  }
  return { mounts: [], env: {} };
}

export async function getBuiltinLaunchpadSkillMounts(
  projectHome: string,
): Promise<OptionalBindMount[]> {
  const codexHome = `${process.env.COCALC_CODEX_HOME ?? ""}`.trim();
  const home = `${process.env.HOME ?? ""}`.trim();
  const hostSkillsRoot = codexHome
    ? join(codexHome, "skills")
    : home
      ? join(home, ".codex", "skills")
      : "";
  if (!hostSkillsRoot) return [];

  const projectSkillsRoot = join(projectHome, ".codex", "skills");
  try {
    await fs.mkdir(projectSkillsRoot, { recursive: true, mode: 0o700 });
  } catch {
    // Best effort: project home mount may already provide this path.
  }

  const mounts: OptionalBindMount[] = [];
  for (const skillName of BUILTIN_LAUNCHPAD_SKILLS) {
    const source = join(hostSkillsRoot, skillName);
    const projectSkill = join(projectSkillsRoot, skillName);
    try {
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const projectStat = await fs.stat(projectSkill);
      if (projectStat.isDirectory()) continue;
    } catch {
      // Missing project-local skill is the normal case.
    }
    mounts.push({
      source,
      target: `/root/.codex/skills/${skillName}`,
      readOnly: true,
    });
  }
  return mounts;
}

function truncateForLog(value: string | undefined, max = 500): string {
  if (!value) return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    const payload = Buffer.from(pad, "base64").toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractChatgptClaims(claims: Record<string, unknown> | undefined): {
  chatgptAccountId?: string;
  chatgptPlanType?: string;
} {
  if (!claims) return {};
  const auth = claims["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return {};
  const chatgptAccountId =
    typeof (auth as any).chatgpt_account_id === "string"
      ? `${(auth as any).chatgpt_account_id}`.trim()
      : undefined;
  const chatgptPlanType =
    typeof (auth as any).chatgpt_plan_type === "string"
      ? `${(auth as any).chatgpt_plan_type}`.trim()
      : undefined;
  return {
    chatgptAccountId: chatgptAccountId || undefined,
    chatgptPlanType: chatgptPlanType || undefined,
  };
}

async function resolveAppServerLoginHint(
  authRuntime: CodexAuthRuntime,
): Promise<CodexAppServerLoginHint | undefined> {
  const apiKey = authRuntime.env.OPENAI_API_KEY?.trim();
  if (
    apiKey &&
    (authRuntime.source === "project-api-key" ||
      authRuntime.source === "account-api-key" ||
      authRuntime.source === "site-api-key")
  ) {
    return {
      type: "apiKey",
      apiKey,
    };
  }
  const codexHome =
    authRuntime.codexHome ??
    (authRuntime.source === "shared-home"
      ? resolveSharedCodexHome()
      : undefined);
  if (!codexHome) return undefined;
  try {
    const raw = await fs.readFile(join(codexHome, "auth.json"), "utf8");
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw);
    const tokens = parsed?.tokens;
    const accessToken =
      typeof tokens?.access_token === "string"
        ? tokens.access_token.trim()
        : "";
    if (!accessToken) return undefined;
    const accessClaims = extractChatgptClaims(decodeJwtClaims(accessToken));
    const idToken =
      typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
    const idClaims = extractChatgptClaims(
      idToken ? decodeJwtClaims(idToken) : undefined,
    );
    const chatgptAccountId =
      (typeof tokens?.account_id === "string"
        ? tokens.account_id.trim()
        : "") ||
      accessClaims.chatgptAccountId ||
      idClaims.chatgptAccountId;
    if (!chatgptAccountId) return undefined;
    return {
      type: "chatgptAuthTokens",
      accessToken,
      chatgptAccountId,
      chatgptPlanType: accessClaims.chatgptPlanType ?? idClaims.chatgptPlanType,
    };
  } catch {
    return undefined;
  }
}

async function resolveLatestAppServerLoginHint({
  projectId,
  accountId,
}: {
  projectId: string;
  accountId?: string;
}): Promise<CodexAppServerLoginHint | undefined> {
  const authRuntime = await resolveCodexAuthRuntime({
    projectId,
    accountId,
  });
  return await resolveAppServerLoginHint(authRuntime);
}

function createAppServerRequestHandler({
  projectId,
  accountId,
  authRuntime,
}: {
  projectId: string;
  accountId?: string;
  authRuntime: CodexAuthRuntime;
}): CodexAppServerRequestHandler {
  return async (request: CodexAppServerRequest) => {
    switch (request.method) {
      case "account/chatgptAuthTokens/refresh": {
        const refreshed = await resolveLatestAppServerLoginHint({
          projectId,
          accountId,
        });
        if (refreshed?.type !== "chatgptAuthTokens") {
          throw new Error(
            `chatgptAuthTokens refresh is not available for auth source ${authRuntime.source}`,
          );
        }
        const previousAccountId =
          typeof request.params?.previousAccountId === "string"
            ? request.params.previousAccountId.trim()
            : "";
        if (
          previousAccountId &&
          refreshed.chatgptAccountId !== previousAccountId
        ) {
          logger.warn(
            "codex project runtime: refreshed chatgpt account mismatch",
            {
              projectId,
              accountId,
              previousAccountId,
              refreshedAccountId: refreshed.chatgptAccountId,
            },
          );
        }
        return {
          accessToken: refreshed.accessToken,
          chatgptAccountId: refreshed.chatgptAccountId,
          chatgptPlanType: refreshed.chatgptPlanType ?? null,
        };
      }
      default:
        throw new Error(`unsupported app-server request: ${request.method}`);
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function podman(
  args: string[],
  {
    timeoutMs = PODMAN_TIMEOUT_MS,
    label,
  }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "podman",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: podmanEnv(),
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const detail = truncateForLog(stderr || stdout);
        const timedOut =
          (err as any)?.killed === true ||
          `${(err as any)?.code ?? ""}` === "ETIMEDOUT";
        const context = label ? ` (${label})` : "";
        reject(
          new Error(
            timedOut
              ? `podman${context} timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`
              : `podman${context} failed${detail ? `: ${detail}` : ""}`,
          ),
        );
      },
    );
  });
}

async function podmanOutput(
  args: string[],
  {
    timeoutMs = PODMAN_TIMEOUT_MS,
    label,
  }: { timeoutMs?: number; label?: string } = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "podman",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: podmanEnv(),
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout ?? "");
          return;
        }
        const detail = truncateForLog(stderr || stdout);
        const timedOut =
          (err as any)?.killed === true ||
          `${(err as any)?.code ?? ""}` === "ETIMEDOUT";
        const context = label ? ` (${label})` : "";
        reject(
          new Error(
            timedOut
              ? `podman${context} timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`
              : `podman${context} failed${detail ? `: ${detail}` : ""}`,
          ),
        );
      },
    );
  });
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await podman(["container", "exists", name], {
      label: "container exists",
    });
    return true;
  } catch {
    return false;
  }
}

async function containerIsRunning(name: string): Promise<boolean> {
  try {
    const output = await podmanOutput(
      ["inspect", "-f", "{{.State.Running}}", name],
      {
        label: "container inspect running",
      },
    );
    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function ensureProjectContainerRunning(projectId: string): Promise<void> {
  const name = projectContainerName(projectId);
  if (await containerIsRunning(name)) return;

  const row = getProject(projectId);
  if (!row) {
    throw new Error(`project ${projectId} is not hosted on this project-host`);
  }

  const state = `${row.state ?? ""}`.trim().toLowerCase();
  if (state !== "starting" && state !== "running") {
    if (!hubApi.projects.start) {
      throw new Error("project start API is not available");
    }
    logger.info("codex project runtime: starting project container", {
      projectId,
      state,
    });
    await hubApi.projects.start({ project_id: projectId });
  }

  const deadline = Date.now() + PROJECT_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await containerIsRunning(name)) return;
    await delay(PROJECT_START_POLL_MS);
  }
  throw new Error(
    `project container ${name} did not start within ${PROJECT_START_TIMEOUT_MS}ms`,
  );
}

async function resolveCodexBinary(): Promise<{
  hostPath: string;
  containerPath: string;
  mount: string;
}> {
  const configuredBinPath = process.env.COCALC_BIN_PATH;
  if (configuredBinPath) {
    const candidate = join(configuredBinPath, "codex");
    try {
      await fs.stat(candidate);
      const hostDir = dirname(candidate);
      const mount = "/opt/codex/bin";
      const containerPath = join(mount, basename(candidate));
      return { hostPath: candidate, containerPath, mount: hostDir };
    } catch {
      // Ignore missing codex in COCALC_BIN_PATH and fall back to normal resolution.
    }
  }

  const requested = process.env.COCALC_CODEX_BIN ?? "codex";
  let hostPath = requested;
  if (!isAbsolute(hostPath)) {
    const resolved = await which(requested);
    if (!resolved) {
      throw new Error(
        `COCALC_CODEX_BIN must be absolute or in PATH (got ${requested})`,
      );
    }
    hostPath = resolved;
  }
  const hostDir = dirname(hostPath);
  const mount = "/opt/codex/bin";
  const containerPath = join(mount, basename(hostPath));
  return { hostPath, containerPath, mount: hostDir };
}

const containerLeases = new RefcountLeaseManager<string>({
  delayMs: CONTAINER_TTL_MS,
  disposer: async (key: string) => {
    const { projectId, contextId } = parseLeaseKey(key);
    const name = codexContainerName(projectId, contextId);
    try {
      await podman(["rm", "-f", "-t", "0", name], {
        label: "container rm",
      });
    } catch (err) {
      logger.debug("codex container rm failed", {
        projectId,
        contextId,
        err: `${err}`,
      });
    }
    await unmount(projectId);
  },
});

async function ensureContainer({
  projectId,
  accountId,
  authRuntime,
  extraEnv,
}: {
  projectId: string;
  accountId?: string;
  authRuntime: CodexAuthRuntime;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<ContainerInfo> {
  const { home, scratch } = await localPath({ project_id: projectId });
  const image = (await fs.readFile(getImageNamePath(home), "utf8")).trim();
  const rootfs = await mountRootFs({
    project_id: projectId,
    home,
    config: { image },
  });
  const name = codexContainerName(projectId, authRuntime.contextId);
  const { containerPath, mount } = await resolveCodexBinary();
  const codexHome =
    authRuntime.codexHome ??
    (authRuntime.source === "shared-home"
      ? resolveSharedCodexHome()
      : undefined);
  const projectCodexHome = join(home, ".codex");
  const projectRow = getProject(projectId);
  const hasGpu =
    projectRow?.run_quota?.gpu === true ||
    (projectRow?.run_quota?.gpu_count ?? 0) > 0;

  if (await containerExists(name)) {
    if (!(await containerIsRunning(name))) {
      logger.warn(
        "codex project container exists but is not running; recreating",
        {
          projectId,
          name,
          auth: redactCodexAuthRuntime(authRuntime),
        },
      );
      try {
        await podman(["rm", "-f", "-t", "0", name], {
          label: "container rm stale",
        });
      } catch (err) {
        logger.warn("failed removing stale codex project container", {
          projectId,
          name,
          err: `${err}`,
        });
      }
    } else {
      return {
        name,
        rootfs,
        codexPath: containerPath,
        home,
        scratch,
      };
    }
  }

  const args: string[] = [];
  args.push("run", "--runtime", "/usr/bin/crun", "--detach", "--rm");
  args.push("--security-opt", "no-new-privileges");
  args.push(networkArgument());
  if (hasGpu) {
    args.push("--device", "nvidia.com/gpu=all");
    args.push("--security-opt", "label=disable");
  }
  args.push("--name", name, "--hostname", name);
  args.push("--workdir", "/root");

  const env = await getEnvironment({
    project_id: projectId,
    HOME: "/root",
    image,
  });
  if (!env.OPENAI_API_KEY?.trim()) {
    // Avoid passing an empty OPENAI_API_KEY, which can force unauthenticated
    // API mode and shadow valid file-based auth.
    delete env.OPENAI_API_KEY;
  }
  const optionalCerts = await getOptionalCertMounts();
  for (const key in optionalCerts.env) {
    if (!env[key]) {
      env[key] = optionalCerts.env[key];
    }
  }
  for (const key in authRuntime.env) {
    env[key] = authRuntime.env[key];
  }
  const cliBearer = await resolveProjectCliBearer({
    projectId,
    accountId,
    currentEnv: { ...env, ...authRuntime.env, ...extraEnv },
  });
  if (cliBearer) {
    env.COCALC_BEARER_TOKEN = cliBearer;
    env.COCALC_AGENT_TOKEN = cliBearer;
  }
  applyProjectRuntimeCliEnv(env, accountId);
  if (extraEnv) {
    for (const key in extraEnv) {
      if (typeof extraEnv[key] === "string") {
        const value = `${extraEnv[key]}`;
        if (key === "OPENAI_API_KEY" && !value.trim()) {
          // Do not let an empty per-turn env override a resolved auth key.
          continue;
        }
        env[key] = value;
      }
    }
  }
  env.COCALC_API_URL = resolveProjectRuntimeApiUrl(env.COCALC_API_URL);
  applyProjectRuntimeCliEnv(env, accountId);
  for (const key in env) {
    args.push("-e", `${key}=${env[key]}`);
  }

  args.push(mountArg({ source: home, target: "/root" }));
  try {
    await fs.mkdir(projectCodexHome, { recursive: true, mode: 0o700 });
  } catch {
    // best effort: project home mount may already provide this path
  }
  if (scratch) {
    args.push(mountArg({ source: scratch, target: "/scratch" }));
  }
  const mounts = getCoCalcMounts();
  for (const src in mounts) {
    try {
      await fs.stat(src);
      args.push(mountArg({ source: src, target: mounts[src], readOnly: true }));
    } catch {
      logger.debug("codex project: skipping missing optional mount", {
        projectId,
        source: src,
        target: mounts[src],
      });
    }
  }
  args.push(
    mountArg({ source: mount, target: "/opt/codex/bin", readOnly: true }),
  );
  if (codexHome && authRuntime.source === "shared-home") {
    try {
      const stat = await fs.stat(codexHome);
      if (stat.isDirectory()) {
        args.push(mountArg({ source: codexHome, target: "/root/.codex" }));
      }
    } catch {
      // ignore if codex home missing
    }
  }
  if (codexHome && authRuntime.source === "subscription") {
    // Subscription auth should not live in project storage. Mount only the auth
    // files from secrets, while keeping /root/.codex/sessions in the project.
    const authPath = join(codexHome, "auth.json");
    const configPath = join(codexHome, "config.toml");
    try {
      const stat = await fs.stat(authPath);
      if (stat.isFile()) {
        args.push(
          mountArg({
            source: authPath,
            target: "/root/.codex/auth.json",
          }),
        );
      }
    } catch {
      // missing auth file -- runtime may fail auth, but do not fall back to
      // workspace auth.json in launchpad mode.
    }
    try {
      const stat = await fs.stat(configPath);
      if (stat.isFile()) {
        args.push(
          mountArg({
            source: configPath,
            target: "/root/.codex/config.toml",
          }),
        );
      }
    } catch {
      // optional
    }
  }
  if (authRuntime.source !== "shared-home") {
    const builtinSkillMounts = await getBuiltinLaunchpadSkillMounts(home);
    for (const mount of builtinSkillMounts) {
      args.push(
        mountArg({
          source: mount.source,
          target: mount.target,
          readOnly: mount.readOnly,
        }),
      );
    }
  }
  for (const mount of optionalCerts.mounts) {
    args.push(
      mountArg({
        source: mount.source,
        target: mount.target,
        readOnly: mount.readOnly,
      }),
    );
  }

  args.push("--rootfs", rootfs);
  args.push("/bin/sh", "-lc", "sleep infinity");

  logger.debug("codex project container: podman", {
    projectId,
    name,
    auth: redactCodexAuthRuntime(authRuntime),
    cmd: redactPodmanArgs(args),
  });
  await podman(args, { label: "container run" });

  return {
    name,
    rootfs,
    codexPath: containerPath,
    home,
    scratch,
  };
}

function toStringEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const key in env) {
    if (typeof env[key] === "string") {
      out[key] = `${env[key]}`;
    }
  }
  return out;
}

export type SpawnCodexInProjectContainerOptions = {
  projectId: string;
  accountId?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  authRuntime?: CodexAuthRuntime;
  touchReason?: string | false;
  forceRefreshSiteKey?: boolean;
};

export type SpawnCodexInProjectContainerResult = {
  proc: ReturnType<typeof spawn>;
  cmd: string;
  args: string[];
  cwd?: string;
  authRuntime: CodexAuthRuntime;
  containerName: string;
  home: string;
  scratch?: string;
};

export async function spawnCodexInProjectContainer({
  projectId,
  accountId,
  args,
  cwd,
  env: extraEnv,
  authRuntime: explicitAuthRuntime,
  touchReason = "codex",
  forceRefreshSiteKey = false,
}: SpawnCodexInProjectContainerOptions): Promise<SpawnCodexInProjectContainerResult> {
  const authRuntime =
    explicitAuthRuntime ??
    (await resolveCodexAuthRuntime({
      projectId,
      accountId,
      forceRefreshSiteKey,
    }));
  let codexArgs = args;
  if (
    authRuntime.source === "project-api-key" ||
    authRuntime.source === "account-api-key" ||
    authRuntime.source === "site-api-key"
  ) {
    // Codex's built-in OpenAI provider expects auth from auth.json by default.
    // For key-based auth in project-host, force a provider that reads
    // OPENAI_API_KEY from env so turns can run without mutating user auth.json.
    codexArgs = [
      ...codexArgs,
      "--config",
      API_KEY_PROVIDER_CONFIG,
      "--config",
      API_KEY_PROVIDER_SELECT,
    ];
    logger.debug("codex project: forcing API-key provider config", {
      projectId,
      accountId,
      source: authRuntime.source,
      provider: API_KEY_PROVIDER_ID,
    });
  }
  if (explicitAuthRuntime) {
    logger.debug("using explicit codex auth runtime", {
      projectId,
      accountId,
      ...redactCodexAuthRuntime(authRuntime),
    });
  } else {
    logResolvedCodexAuthRuntime(projectId, accountId, authRuntime);
  }
  const key = leaseKey(projectId, authRuntime.contextId);
  const release = await containerLeases.acquire(key);
  let info: ContainerInfo | undefined;
  try {
    info = await withTimeout(
      ensureContainer({ projectId, accountId, authRuntime, extraEnv }),
      CONTAINER_SETUP_TIMEOUT_MS,
      `codex container setup (project=${projectId})`,
    );
  } catch (err) {
    await release();
    throw err;
  }

  const execArgs: string[] = [
    "exec",
    "-i",
    "--workdir",
    cwd && cwd.startsWith("/") ? cwd : "/root",
    "-e",
    "HOME=/root",
  ];
  const execEnv = { ...authRuntime.env, ...toStringEnv(extraEnv) };
  const cliBearer = await resolveProjectCliBearer({
    projectId,
    accountId,
    currentEnv: execEnv,
  });
  if (cliBearer) {
    execEnv.COCALC_BEARER_TOKEN = cliBearer;
    execEnv.COCALC_AGENT_TOKEN = cliBearer;
  }
  if (!execEnv.OPENAI_API_KEY?.trim()) {
    // Avoid overriding runtime key selection with an empty per-turn value.
    delete execEnv.OPENAI_API_KEY;
  }
  for (const key in execEnv) {
    execArgs.push("-e", `${key}=${execEnv[key]}`);
  }
  execArgs.push(info.name, info.codexPath, ...codexArgs);
  logger.debug("codex project: podman exec", redactPodmanArgs(execArgs));
  const proc = spawn("podman", execArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: podmanEnv(),
  });
  proc.on("exit", async () => {
    try {
      if (
        authRuntime.source === "subscription" &&
        accountId &&
        authRuntime.codexHome
      ) {
        try {
          await syncSubscriptionAuthToRegistryIfChanged({
            projectId,
            accountId,
            codexHome: authRuntime.codexHome,
          });
        } catch (err) {
          logger.debug("codex project: failed syncing subscription auth", {
            projectId,
            accountId,
            codexHome: authRuntime.codexHome,
            err: `${err}`,
          });
        }
      }
      await release();
    } finally {
      if (touchReason) {
        void touchProjectLastEdited(projectId, touchReason);
      }
    }
  });
  return {
    proc,
    cmd: "podman",
    args: execArgs,
    cwd,
    authRuntime,
    containerName: info.name,
    home: info.home,
    scratch: info.scratch,
  };
}

type SpawnCodexAppServerInProjectRuntimeOptions = {
  projectId: string;
  accountId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  forceRefreshSiteKey?: boolean;
  touchReason?: string | false;
};

type SpawnCodexAppServerInProjectRuntimeResult = {
  proc: ReturnType<typeof spawn>;
  cmd: string;
  args: string[];
  cwd?: string;
  authRuntime: CodexAuthRuntime;
  home: string;
  scratch?: string;
  appServerLogin?: CodexAppServerLoginHint;
  handleAppServerRequest?: CodexAppServerRequestHandler;
  runtimeEnv?: Record<string, string>;
};

async function spawnCodexAppServerInProjectRuntime({
  projectId,
  accountId,
  cwd,
  env: extraEnv,
  forceRefreshSiteKey = false,
  touchReason = "codex",
}: SpawnCodexAppServerInProjectRuntimeOptions): Promise<SpawnCodexAppServerInProjectRuntimeResult> {
  const authRuntime = await resolveCodexAuthRuntime({
    projectId,
    accountId,
    forceRefreshSiteKey,
  });
  logResolvedCodexAuthRuntime(projectId, accountId, authRuntime);
  const appServerLogin = await resolveAppServerLoginHint(authRuntime);
  const handleAppServerRequest = createAppServerRequestHandler({
    projectId,
    accountId,
    authRuntime,
  });
  await ensureProjectContainerRunning(projectId);
  const { home, scratch } = await localPath({ project_id: projectId });
  const name = projectContainerName(projectId);

  const execArgs: string[] = [
    "exec",
    "-i",
    "--workdir",
    cwd && cwd.startsWith("/") ? cwd : "/root",
    "-e",
    "HOME=/root",
  ];
  const execEnv = toStringEnv(extraEnv);
  const cliBearer = await resolveProjectCliBearer({
    projectId,
    accountId,
    currentEnv: execEnv,
  });
  if (cliBearer) {
    execEnv.COCALC_BEARER_TOKEN = cliBearer;
    execEnv.COCALC_AGENT_TOKEN = cliBearer;
  }
  if (
    appServerLogin?.type === "apiKey" &&
    execEnv.OPENAI_API_KEY &&
    execEnv.OPENAI_API_KEY === authRuntime.env.OPENAI_API_KEY
  ) {
    delete execEnv.OPENAI_API_KEY;
  }
  if (!execEnv.OPENAI_API_KEY?.trim()) {
    delete execEnv.OPENAI_API_KEY;
  }
  applyProjectRuntimeCliEnv(execEnv, accountId);
  execEnv.COCALC_API_URL = resolveProjectRuntimeApiUrl(execEnv.COCALC_API_URL);
  applyProjectRuntimeCliEnv(execEnv, accountId);
  for (const key in execEnv) {
    execArgs.push("-e", `${key}=${execEnv[key]}`);
  }
  const codexArgs: string[] = [];
  if (shouldForceEphemeralAppServerAuthStorage(authRuntime)) {
    // Host-managed auth must stay in-process only. Otherwise app-server's
    // apiKey login path can write credentials into the collaborative
    // project-local CODEX_HOME.
    codexArgs.push("--config", EPHEMERAL_AUTH_STORE_CONFIG);
  }
  execArgs.push(
    name,
    getProjectRuntimeCodexPath(),
    ...codexArgs,
    "app-server",
    "--listen",
    "stdio://",
  );
  logger.debug("codex project runtime: podman exec", {
    projectId,
    auth: redactCodexAuthRuntime(authRuntime),
    loginType: appServerLogin?.type,
    cmd: redactPodmanArgs(execArgs),
  });
  const proc = spawn("podman", execArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: podmanEnv(),
  });
  proc.on("exit", async () => {
    try {
      if (
        authRuntime.source === "subscription" &&
        accountId &&
        authRuntime.codexHome
      ) {
        try {
          await syncSubscriptionAuthToRegistryIfChanged({
            projectId,
            accountId,
            codexHome: authRuntime.codexHome,
          });
        } catch (err) {
          logger.debug(
            "codex project runtime: failed syncing subscription auth",
            {
              projectId,
              accountId,
              codexHome: authRuntime.codexHome,
              err: `${err}`,
            },
          );
        }
      }
    } finally {
      if (touchReason) {
        void touchProjectLastEdited(projectId, touchReason);
      }
    }
  });
  return {
    proc,
    cmd: "podman",
    args: execArgs,
    cwd,
    authRuntime,
    home,
    scratch,
    appServerLogin,
    handleAppServerRequest,
    runtimeEnv: execEnv,
  };
}

export function initCodexProjectRunner(): void {
  setCodexProjectSpawner({
    async spawnCodexExec({
      projectId,
      accountId,
      args,
      cwd,
      env: extraEnv,
      forceRefreshSiteKey,
    }) {
      const hasSandboxFlag =
        args.includes("--full-auto") ||
        args.includes("--dangerously-bypass-approvals-and-sandbox") ||
        args.includes("--sandbox");
      if (!hasSandboxFlag) {
        logger.warn(
          "codex project: missing sandbox flag; defaulting to --full-auto",
        );
      }
      const spawned = await spawnCodexInProjectContainer({
        projectId,
        accountId,
        cwd,
        env: extraEnv,
        args: hasSandboxFlag ? args : ["--full-auto", ...args],
        touchReason: "codex",
        forceRefreshSiteKey,
      });
      return {
        proc: spawned.proc,
        cmd: spawned.cmd,
        args: spawned.args,
        cwd: spawned.cwd,
        authSource: spawned.authRuntime.source,
        containerPathMap: {
          rootHostPath: spawned.home,
          scratchHostPath: spawned.scratch,
        },
      };
    },
    async spawnCodexAppServer({ projectId, accountId, cwd, env: extraEnv }) {
      const spawned = await spawnCodexAppServerInProjectRuntime({
        projectId,
        accountId,
        cwd,
        env: extraEnv,
        touchReason: "codex",
      });
      return {
        proc: spawned.proc,
        cmd: spawned.cmd,
        args: spawned.args,
        cwd: spawned.cwd,
        authSource: spawned.authRuntime.source,
        containerPathMap: {
          rootHostPath: spawned.home,
          scratchHostPath: spawned.scratch,
        },
        appServerLogin: spawned.appServerLogin,
        handleAppServerRequest: spawned.handleAppServerRequest,
        runtimeEnv: spawned.runtimeEnv,
      };
    },
  });
}
