import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import getLogger from "@cocalc/backend/logger";
import {
  ensureCodexCredentialsStoreFile,
  resolveSubscriptionCodexHome,
  subscriptionRuntime,
} from "./codex-auth";
import { pushSubscriptionAuthToRegistry } from "./codex-auth-registry";
import { touchSubscriptionCacheUsage } from "./codex-subscription-cache-gc";
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
  syncedToRegistry?: boolean;
  syncError?: string;
};

const MAX_OUTPUT_CHARS = 50_000;
const sessions = new Map<string, DeviceAuthSession>();

function classifyDeviceAuthFailure(output: string, code: number | null): string {
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

function stripAnsi(text: string): string {
  // Remove ANSI CSI/OSC escapes so parsed URLs/codes are clean for UI display.
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
    const m = session.output.match(/https?:\/\/[^\s)]+/);
    if (m) {
      session.verificationUrl = m[0];
    }
  }
  if (!session.userCode) {
    // Prefer the code shown immediately after the "one-time code" instruction.
    const explicit = session.output.match(
      /one-time code[^\n]*\n\s*([A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,2})\b/i,
    );
    if (explicit?.[1]) {
      session.userCode = explicit[1];
      return;
    }

    // Fallback: any code-shaped token (contains at least one hyphen).
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

export async function startCodexDeviceAuth(
  projectId: string,
  accountId: string,
): Promise<ReturnType<typeof snapshot>> {
  const codexHome = resolveSubscriptionCodexHome(accountId);
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
      void touchSubscriptionCacheUsage(session.codexHome).catch((err) => {
        logger.warn("failed to touch local codex subscription cache marker", {
          id,
          projectId,
          accountId,
          err: `${err}`,
        });
      });
      void pushSubscriptionAuthToRegistry({
        projectId: session.projectId,
        accountId: session.accountId,
        codexHome: session.codexHome,
      })
        .then((result) => {
          session.syncedToRegistry = result.ok;
          session.syncError = result.ok
            ? undefined
            : "unable to sync credentials to central registry";
          session.updatedAt = Date.now();
        })
        .catch((err) => {
          session.syncedToRegistry = false;
          session.syncError = `${err}`;
          session.updatedAt = Date.now();
        });
    } else {
      session.state = "failed";
      if (!session.error) {
        // Promote common known failures to actionable user-facing errors.
        session.error = classifyDeviceAuthFailure(session.output, code ?? null);
        if (session.error.startsWith("codex login exited")) {
          session.error = `codex login exited with code=${code} signal=${signal}`;
        }
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
    syncedToRegistry: session.syncedToRegistry,
    syncError: session.syncError,
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
