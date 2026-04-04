import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("lite:hub:codex-auth");
const MAX_AUTH_UPLOAD_BYTES = 2_000_000;
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

type DeviceAuthState = "pending" | "completed" | "failed" | "canceled";

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
};

const sessions = new Map<string, DeviceAuthSession>();

export function resolveLiteCodexHome(): string {
  const configured = `${process.env.COCALC_CODEX_HOME ?? ""}`.trim();
  if (configured) return configured;
  const home = `${process.env.HOME ?? ""}`.trim();
  if (home) return join(home, ".codex");
  return join(process.cwd(), ".codex");
}

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

function validateUploadedAuthJson(raw: string): void {
  if (!raw?.trim()) {
    throw Error("uploaded file is empty");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_UPLOAD_BYTES) {
    throw Error("uploaded file is too large");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error("uploaded file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Error("uploaded file must contain a JSON object");
  }
}

export async function uploadLiteSubscriptionAuthFile({
  content,
}: {
  content: string;
}): Promise<{ codexHome: string; bytes: number }> {
  validateUploadedAuthJson(content);
  const codexHome = resolveLiteCodexHome();
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(codexHome, "auth.json"), content, { mode: 0o600 });
  await ensureCodexCredentialsStoreFile(codexHome);
  return {
    codexHome,
    bytes: Buffer.byteLength(content, "utf8"),
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
    if (!isTerminal(session.state)) continue;
    if (now - session.updatedAt > DEVICE_AUTH_TERMINAL_RETENTION_MS) {
      sessions.delete(id);
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
  };
}

export type LiteCodexDeviceAuthStatus = ReturnType<typeof snapshot>;

export async function startLiteCodexDeviceAuth({
  projectId,
  accountId,
}: {
  projectId: string;
  accountId: string;
}): Promise<LiteCodexDeviceAuthStatus> {
  pruneSessions();
  if (sessions.size >= DEVICE_AUTH_MAX_SESSIONS) {
    throw Error(
      "Too many codex device-auth sessions are active on this host; please retry shortly.",
    );
  }
  const codexHome = resolveLiteCodexHome();
  await ensureCodexCredentialsStoreFile(codexHome);
  await ensureCodexAuthFileExists(codexHome);
  const binary = `${process.env.COCALC_CODEX_BIN ?? "codex"}`.trim() || "codex";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COCALC_CODEX_HOME: codexHome,
  };
  if (basename(codexHome) === ".codex") {
    env.HOME = dirname(codexHome);
  }
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
  };
  sessions.set(session.id, session);

  proc.stdout?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.stderr?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.on("error", (err) => {
    session.state = "failed";
    session.error = `${err}`;
    session.updatedAt = Date.now();
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
    if (session.state === "canceled") return;
    if (code === 0) {
      session.state = "completed";
      return;
    }
    session.state = "failed";
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

export function cancelLiteCodexDeviceAuth(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.state !== "pending") return false;
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
