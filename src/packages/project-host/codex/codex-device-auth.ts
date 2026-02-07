import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import getLogger from "@cocalc/backend/logger";
import {
  ensureCodexCredentialsStoreFile,
  resolveSubscriptionCodexHome,
  subscriptionRuntime,
} from "./codex-auth";
import { spawnCodexInProjectContainer } from "./codex-project";

const logger = getLogger("project-host:codex-device-auth");

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

export async function startCodexDeviceAuth(
  projectId: string,
  accountId: string,
): Promise<ReturnType<typeof snapshot>> {
  const codexHome = resolveSubscriptionCodexHome(accountId);
  if (!codexHome) {
    throw new Error(
      "COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT must be set for device auth",
    );
  }
  await ensureCodexCredentialsStoreFile(codexHome);
  // Ensure we run in subscription auth mode (not key/shared-home fallback)
  // while performing device login.
  const authRuntime = subscriptionRuntime({
    projectId,
    accountId,
    codexHome,
  });

  const spawned = await spawnCodexInProjectContainer({
    projectId,
    accountId,
    args: ["login", "--device-auth"],
    authRuntime,
    touchReason: "codex-device-auth",
  });
  const id = randomUUID();
  const proc = spawned.proc;
  const session: DeviceAuthSession = {
    id,
    projectId,
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
    } else {
      session.state = "failed";
      if (!session.error) {
        session.error = `codex login exited with code=${code} signal=${signal}`;
      }
    }
    logger.debug("codex device auth exited", {
      id,
      projectId,
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
