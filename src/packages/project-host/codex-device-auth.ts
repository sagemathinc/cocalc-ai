import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:codex-device-auth");

type DeviceAuthState = "pending" | "completed" | "failed" | "canceled";

type DeviceAuthSession = {
  id: string;
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

const MAX_OUTPUT_CHARS = 50_000;
const sessions = new Map<string, DeviceAuthSession>();

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

function updateParsedHints(session: DeviceAuthSession): void {
  if (!session.verificationUrl) {
    const m = session.output.match(/https?:\/\/[^\s)]+/);
    if (m) {
      session.verificationUrl = m[0];
    }
  }
  if (!session.userCode) {
    const codeLine = session.output.match(
      /(?:one-time code|enter code|code)\s*[:\n ]+\s*([A-Z0-9-]{6,})/i,
    );
    if (codeLine?.[1]) {
      session.userCode = codeLine[1];
      return;
    }
    const fallback = session.output.match(/\b[A-Z0-9-]{8,}\b/g);
    if (fallback && fallback.length > 0) {
      session.userCode = fallback[fallback.length - 1];
    }
  }
}

function appendOutput(session: DeviceAuthSession, chunk: string): void {
  session.output = trimOutput(`${session.output}${chunk}`);
  session.updatedAt = Date.now();
  updateParsedHints(session);
}

function subscriptionRootPath(): string {
  const root = process.env.COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT;
  if (!root) {
    throw new Error(
      "COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT must be set for device auth",
    );
  }
  return root;
}

export async function startCodexDeviceAuth(
  accountId: string,
): Promise<ReturnType<typeof snapshot>> {
  const root = subscriptionRootPath();
  const codexHome = join(root, accountId);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const proc = spawn("codex", ["login", "--device-auth"], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const session: DeviceAuthSession = {
    id,
    accountId,
    codexHome,
    proc,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    state: "pending",
    output: "",
  };
  sessions.set(id, session);

  proc.stdout?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.stderr?.on("data", (chunk) => appendOutput(session, chunk.toString()));
  proc.on("error", (err) => {
    session.state = "failed";
    session.error = `${err}`;
    session.updatedAt = Date.now();
    logger.warn("codex device auth spawn error", {
      id,
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
    } else {
      session.state = "failed";
      if (!session.error) {
        session.error = `codex login exited with code=${code} signal=${signal}`;
      }
    }
    logger.debug("codex device auth exited", {
      id,
      accountId,
      state: session.state,
      code,
      signal,
    });
  });

  return snapshot(session);
}

function snapshot(session: DeviceAuthSession) {
  return {
    id: session.id,
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

export function getCodexDeviceAuthStatus(id: string):
  | ReturnType<typeof snapshot>
  | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  return snapshot(session);
}

export function cancelCodexDeviceAuth(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.state !== "pending") return false;
  session.state = "canceled";
  session.updatedAt = Date.now();
  try {
    session.proc.kill("SIGTERM");
  } catch (err) {
    logger.debug("failed to cancel device auth process", {
      id,
      err: `${err}`,
    });
  }
  return true;
}
