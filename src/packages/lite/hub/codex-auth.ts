import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  resolveLiteCodexHome,
  resolveLiteCredentialTarget,
  saveLiteCredential,
  validateLiteSubscriptionAuth,
  type LiteCredentialTarget,
} from "./codex-credentials";
export { resolveLiteCodexHome } from "./codex-credentials";

const logger = getLogger("lite:hub:codex-auth");
const MAX_OUTPUT_CHARS = 50_000;
const DEVICE_AUTH_MAX_SESSIONS = Math.max(
  10,
  Number(process.env.COCALC_CODEX_DEVICE_AUTH_MAX_SESSIONS ?? 200),
);
const DEVICE_AUTH_TERMINAL_RETENTION_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_CODEX_DEVICE_AUTH_TERMINAL_RETENTION_MS ??
      6 * 60 * 60 * 1000,
  ),
);
const DEVICE_AUTH_PRUNE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.COCALC_CODEX_DEVICE_AUTH_PRUNE_INTERVAL_MS ?? 5 * 60_000),
);
const CODEX_CREDENTIAL_STORE_SETTING = 'cli_auth_credentials_store = "file"';

type DeviceAuthState =
  | "pending"
  | "syncing"
  | "completed"
  | "failed"
  | "canceled";

type DeviceAuthSession = {
  id: string;
  projectId: string;
  accountId: string;
  codexHome: string;
  proc: ChildProcess;
  startedAt: number;
  updatedAt: number;
  state: DeviceAuthState;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  output: string;
  verificationUrl?: string;
  userCode?: string;
  syncedToRegistry?: boolean;
  syncError?: string;
  verifyPromise?: Promise<void>;
  credentialId?: string;
  create?: boolean;
};

type DeviceAuthVerifier = (opts: {
  projectId: string;
  accountId: string;
  codexHome: string;
}) => Promise<void>;

const sessions = new Map<string, DeviceAuthSession>();

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function upsertCredentialStoreSetting(configToml: string): string {
  const settingPattern = /^(?!\s*#)\s*cli_auth_credentials_store\s*=\s*.*$/m;
  if (settingPattern.test(configToml)) {
    return configToml.replace(settingPattern, CODEX_CREDENTIAL_STORE_SETTING);
  }
  if (!configToml.trim()) {
    return `${CODEX_CREDENTIAL_STORE_SETTING}\n`;
  }
  const suffix = configToml.endsWith("\n") ? "" : "\n";
  return `${configToml}${suffix}${CODEX_CREDENTIAL_STORE_SETTING}\n`;
}

async function ensureCodexCredentialsStoreFile(
  codexHome: string,
): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    raw = "";
  }
  const updated = upsertCredentialStoreSetting(raw);
  if (updated === raw) return;
  await fs.writeFile(configPath, updated, { mode: 0o600 });
}

async function ensureCodexAuthFileExists(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authPath = join(codexHome, "auth.json");
  if (await pathExists(authPath)) return;
  await fs.writeFile(authPath, "{}\n", { mode: 0o600 });
}

async function createStagingHome(): Promise<string> {
  const root = join(resolveLiteCodexHome(), "cocalc-subscriptions", "staging");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return await fs.mkdtemp(join(root, "login-"));
}

export async function uploadLiteSubscriptionAuthFile({
  content,
  accountId,
  credentialId,
  create,
}: {
  content: string;
  accountId: string;
} & LiteCredentialTarget): Promise<{
  codexHome: string;
  bytes: number;
  credentialId: string;
}> {
  const id = saveLiteCredential(accountId, content, { credentialId, create });
  return {
    codexHome: resolveLiteCodexHome(),
    bytes: Buffer.byteLength(content, "utf8"),
    credentialId: id,
  };
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

function updateParsedHints(session: DeviceAuthSession): void {
  if (!session.verificationUrl) {
    const match = session.output.match(/https?:\/\/[^\s)]+/);
    if (match) {
      session.verificationUrl = match[0];
    }
  }
  if (!session.userCode) {
    const explicit = session.output.match(
      /one-time code[^\n]*\n\s*([A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,2})\b/i,
    );
    if (explicit?.[1]) {
      session.userCode = explicit[1];
      return;
    }
    const fallback = session.output.match(
      /\b[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,2}\b/g,
    );
    if (fallback?.length) {
      session.userCode = fallback[fallback.length - 1];
    }
  }
}

function appendOutput(session: DeviceAuthSession, chunk: string): void {
  const clean = stripAnsi(chunk);
  session.output = trimOutput(`${session.output}${clean}`);
  session.updatedAt = Date.now();
  updateParsedHints(session);
}

function classifyDeviceAuthFailure(
  output: string,
  code: number | null,
): string {
  const text = output ?? "";
  if (
    /status\s*429/i.test(text) ||
    /too many requests/i.test(text) ||
    /rate[-\s]?limit/i.test(text)
  ) {
    return "OpenAI is currently rate-limiting device login requests from this host (HTTP 429). Please wait and try again.";
  }
  if (/workspace admin to enable device code authentication/i.test(text)) {
    return "Device-code login is not enabled for this OpenAI workspace. Use another workspace/account or the auth-file upload fallback.";
  }
  return `codex login exited with code=${code} signal=null`;
}

function isTerminal(state: DeviceAuthState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function pruneSessions(now: number = Date.now()): void {
  for (const [id, session] of sessions) {
    if (
      !isTerminal(session.state) &&
      now - session.startedAt > DEVICE_AUTH_TERMINAL_RETENTION_MS
    ) {
      cancelLiteCodexDeviceAuth(id);
    }
    if (!isTerminal(session.state)) continue;
    if (now - session.updatedAt > DEVICE_AUTH_TERMINAL_RETENTION_MS) {
      sessions.delete(id);
      void fs
        .rm(session.codexHome, { recursive: true, force: true })
        .catch(() => {});
    }
  }
  if (sessions.size < DEVICE_AUTH_MAX_SESSIONS) return;
  const candidates = [...sessions.values()]
    .filter((session) => isTerminal(session.state))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const session of candidates) {
    if (sessions.size < DEVICE_AUTH_MAX_SESSIONS) break;
    sessions.delete(session.id);
  }
}

setInterval(() => {
  try {
    pruneSessions();
  } catch (err) {
    logger.debug("codex device auth prune failed", { err: `${err}` });
  }
}, DEVICE_AUTH_PRUNE_INTERVAL_MS).unref();

function snapshot(session: DeviceAuthSession) {
  return {
    id: session.id,
    projectId: session.projectId,
    accountId: session.accountId,
    codexHome: session.codexHome,
    state: session.state,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    output: session.output,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    exitCode: session.exitCode,
    signal: session.signal,
    error: session.error,
    syncedToRegistry: session.syncedToRegistry,
    syncError: session.syncError,
    credentialId: session.credentialId,
    create: session.create,
    registryCreated: session.syncedToRegistry ? session.create : undefined,
  };
}

export type LiteCodexDeviceAuthStatus = ReturnType<typeof snapshot>;

export async function startLiteCodexDeviceAuth({
  projectId,
  accountId,
  credentialId,
  create,
}: {
  projectId: string;
  accountId: string;
} & LiteCredentialTarget): Promise<LiteCodexDeviceAuthStatus> {
  pruneSessions();
  if (sessions.size >= DEVICE_AUTH_MAX_SESSIONS) {
    throw Error(
      "Too many codex device-auth sessions are active on this host; please retry shortly.",
    );
  }
  const target = resolveLiteCredentialTarget(accountId, {
    credentialId,
    create,
  });
  const codexHome = await createStagingHome();
  await ensureCodexCredentialsStoreFile(codexHome);
  await ensureCodexAuthFileExists(codexHome);
  const binary = `${process.env.COCALC_CODEX_BIN ?? "codex"}`.trim() || "codex";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COCALC_CODEX_HOME: codexHome,
    CODEX_HOME: codexHome,
  };
  const proc = spawn(binary, ["login", "--device-auth"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const now = Date.now();
  const session: DeviceAuthSession = {
    id: randomUUID(),
    projectId,
    accountId,
    codexHome,
    proc,
    startedAt: now,
    updatedAt: now,
    state: "pending",
    output: "",
    ...target,
  };
  sessions.set(session.id, session);

  proc.stdout?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.stderr?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.on("error", (err) => {
    session.state = "failed";
    session.error = `${err}`;
    session.updatedAt = Date.now();
    void fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
    logger.warn("codex device auth spawn error", {
      id: session.id,
      projectId,
      accountId,
      err: `${err}`,
    });
  });
  proc.on("exit", (code, signal) => {
    session.exitCode = code;
    session.signal = signal;
    session.updatedAt = Date.now();
    if (session.state === "canceled") {
      void fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
      return;
    }
    if (code === 0) {
      session.state = "syncing";
      return;
    }
    session.state = "failed";
    void fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
    if (!session.error) {
      session.error = classifyDeviceAuthFailure(session.output, code ?? null);
      if (session.error.startsWith("codex login exited")) {
        session.error = `codex login exited with code=${code} signal=${signal}`;
      }
    }
    logger.debug("codex device auth exited", {
      id: session.id,
      projectId,
      accountId,
      state: session.state,
      code,
      signal,
    });
  });

  return snapshot(session);
}

export function getLiteCodexDeviceAuthStatus(
  id: string,
): LiteCodexDeviceAuthStatus | undefined {
  pruneSessions();
  const session = sessions.get(id);
  if (!session) return;
  return snapshot(session);
}

export async function verifyLiteCodexDeviceAuthStatus(
  id: string,
  verifySubscriptionAuth: DeviceAuthVerifier,
): Promise<LiteCodexDeviceAuthStatus | undefined> {
  pruneSessions();
  const session = sessions.get(id);
  if (!session) return;
  if (session.state !== "syncing") {
    return snapshot(session);
  }
  session.verifyPromise ??= (async () => {
    try {
      await verifySubscriptionAuth({
        projectId: session.projectId,
        accountId: session.accountId,
        codexHome: session.codexHome,
      });
      const current = sessions.get(id);
      if (!current || current.state === "canceled") return;
      const content = await fs.readFile(
        join(current.codexHome, "auth.json"),
        "utf8",
      );
      validateLiteSubscriptionAuth(content);
      if (sessions.get(id)?.state === "canceled") return;
      current.credentialId = saveLiteCredential(current.accountId, content, {
        credentialId: current.credentialId,
        create: current.create,
      });
      current.state = "completed";
      current.syncedToRegistry = true;
      current.syncError = undefined;
      current.updatedAt = Date.now();
    } catch (err) {
      const current = sessions.get(id);
      if (!current || current.state === "canceled") return;
      current.state = "failed";
      current.syncedToRegistry = false;
      current.syncError = `${err}`;
      current.error =
        "ChatGPT sign-in succeeded, but CoCalc could not verify that Codex can use the saved credential. Please try signing in again.";
      current.updatedAt = Date.now();
    } finally {
      const current = sessions.get(id);
      if (current) current.verifyPromise = undefined;
      await fs
        .rm(session.codexHome, { recursive: true, force: true })
        .catch(() => {});
    }
  })();
  if (session.verifyPromise) {
    await session.verifyPromise;
  }
  const current = sessions.get(id);
  return current ? snapshot(current) : undefined;
}

export function cancelLiteCodexDeviceAuth(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.state !== "pending" && session.state !== "syncing") return false;
  if (session.state === "syncing" && !session.verifyPromise) {
    void fs
      .rm(session.codexHome, { recursive: true, force: true })
      .catch(() => {});
  }
  session.state = "canceled";
  session.updatedAt = Date.now();
  try {
    session.proc.kill("SIGTERM");
  } catch (err) {
    logger.debug("failed to cancel lite device auth process", {
      id,
      err: `${err}`,
    });
  }
  return true;
}
