import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, isAbsolute } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { argsJoin } from "@cocalc/util/args";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { setCodexProjectSpawner } from "@cocalc/ai/acp";
import { which } from "@cocalc/backend/which";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { getImageNamePath, mount as mountRootFs, unmount } from "@cocalc/project-runner/run/rootfs";
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

const logger = getLogger("project-host:codex-project");
const CONTAINER_TTL_MS = Number(
  process.env.COCALC_CODEX_PROJECT_TTL_MS ?? 60_000,
);

type ContainerInfo = {
  name: string;
  rootfs: string;
  codexPath: string;
  home: string;
};

type OptionalBindMount = {
  source: string;
  target: string;
  readOnly?: boolean;
};

const API_KEY_PROVIDER_ID = "cocalc-openai-api-key";
const API_KEY_PROVIDER_CONFIG = `model_providers.${API_KEY_PROVIDER_ID}={name="OpenAI",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses",requires_openai_auth=false}`;
const API_KEY_PROVIDER_SELECT = `model_provider="${API_KEY_PROVIDER_ID}"`;

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

async function podman(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("podman", args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await podman(["container", "exists", name]);
    return true;
  } catch {
    return false;
  }
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
      await podman(["rm", "-f", "-t", "0", name]);
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
  authRuntime,
  extraEnv,
}: {
  projectId: string;
  authRuntime: CodexAuthRuntime;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<ContainerInfo> {
  const { home, scratch } = await localPath({ project_id: projectId });
  const image = (await fs.readFile(getImageNamePath(home), "utf8")).trim();
  const rootfs = await mountRootFs({ project_id: projectId, home, config: { image } });
  const name = codexContainerName(projectId, authRuntime.contextId);
  const { containerPath, mount } = await resolveCodexBinary();
  const codexHome =
    authRuntime.codexHome ??
    (authRuntime.source === "shared-home" ? resolveSharedCodexHome() : undefined);
  const projectCodexHome = join(home, ".codex");
  const projectRow = getProject(projectId);
  const hasGpu =
    projectRow?.run_quota?.gpu === true ||
    (projectRow?.run_quota?.gpu_count ?? 0) > 0;

  if (await containerExists(name)) {
    return { name, rootfs, codexPath: containerPath, home };
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
  args.push(mountArg({ source: mount, target: "/opt/codex/bin", readOnly: true }));
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
  await podman(args);

  return { name, rootfs, codexPath: containerPath, home };
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
    info = await ensureContainer({ projectId, authRuntime, extraEnv });
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
  });
  proc.on("exit", async () => {
    try {
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
      };
    },
  });
}
