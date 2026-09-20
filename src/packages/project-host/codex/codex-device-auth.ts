import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import {
  ensureCodexAuthFileExists,
  ensureCodexCredentialsStoreFile,
  resolveSubscriptionStagingHome,
  subscriptionRuntime,
} from "./codex-auth";
import {
  acquireCodexDeviceAuthLease,
  pushSubscriptionAuthToRegistry,
  releaseCodexDeviceAuthLease,
} from "./codex-auth-registry";
import { touchSubscriptionCacheUsage } from "./codex-subscription-cache-gc";
import { spawnCodexInProjectContainer } from "./codex-project";
import { PROJECT_RUNTIME_SUBSCRIPTION_CODEX_HOME } from "./codex-runtime-paths";

const logger = getLogger("project-host:codex-device-auth");

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
  credentialId?: string;
  create: boolean;
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
  registryCreated?: boolean;
  syncError?: string;
  leaseId: string;
};

type DeviceAuthVerifier = (opts: {
  projectId: string;
  accountId: string;
  codexHome: string;
  credentialId?: string;
}) => Promise<{ descriptorMetadata?: { email?: string } } | void>;

const MAX_OUTPUT_CHARS = 50_000;
const sessions = new Map<string, DeviceAuthSession>();
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

function isTerminal(state: DeviceAuthState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function pruneSessions(now: number = Date.now()): void {
  // First pass: drop old terminal sessions.
  for (const [id, session] of sessions) {
    if (!isTerminal(session.state)) continue;
    if (now - session.updatedAt > DEVICE_AUTH_TERMINAL_RETENTION_MS) {
      sessions.delete(id);
    }
  }

  if (sessions.size < DEVICE_AUTH_MAX_SESSIONS) return;

  // Second pass: while above cap, evict oldest terminal sessions first.
  const candidates = [...sessions.values()]
    .filter((s) => isTerminal(s.state))
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

async function cleanupPendingAuthHome(
  session: DeviceAuthSession,
): Promise<void> {
  try {
    await rm(session.codexHome, { recursive: true, force: true });
  } catch (err) {
    logger.warn("failed to remove pending codex auth directory", {
      id: session.id,
      projectId: session.projectId,
      accountId: session.accountId,
      err: `${err}`,
    });
  }
  await releaseCodexDeviceAuthLease({
    projectId: session.projectId,
    accountId: session.accountId,
    leaseId: session.leaseId,
  });
}

export async function startCodexDeviceAuth(
  projectId: string,
  accountId: string,
  verifySubscriptionAuth?: DeviceAuthVerifier,
  options: { credentialId?: string; create?: boolean } = {},
): Promise<ReturnType<typeof snapshot>> {
  pruneSessions();
  if (sessions.size >= DEVICE_AUTH_MAX_SESSIONS) {
    throw new Error(
      "Too many codex device-auth sessions are active on this host; please retry shortly.",
    );
  }
  if (
    [...sessions.values()].some(
      (session) =>
        session.accountId === accountId && !isTerminal(session.state),
    )
  ) {
    throw new Error(
      "A ChatGPT sign-in is already in progress for this CoCalc account.",
    );
  }

  const id = randomUUID();
  const create = options.create === true;
  const credentialId = options.credentialId?.trim() || undefined;
  if (create && credentialId) {
    throw new Error("a new sign-in cannot target an existing credential");
  }
  const leaseId = await acquireCodexDeviceAuthLease({
    projectId,
    accountId,
    sessionId: id,
  });
  // Reconnects must not mutate the live cache until the provider identity has
  // been checked and the central authority accepts the replacement.
  const codexHome = resolveSubscriptionStagingHome(accountId, id);
  try {
    await ensureCodexCredentialsStoreFile(codexHome);
    await ensureCodexAuthFileExists(codexHome);
  } catch (err) {
    await releaseCodexDeviceAuthLease({ projectId, accountId, leaseId });
    throw err;
  }
  // Ensure we run in subscription auth mode (not key/shared-home fallback)
  // while performing device login.
  const authRuntime = subscriptionRuntime({
    projectId,
    accountId,
    codexHome,
    credentialId,
  });

  let spawned;
  try {
    spawned = await spawnCodexInProjectContainer({
      projectId,
      accountId,
      args: ["login", "--device-auth"],
      // Keep this process-specific. Normal Codex turns retain project-local
      // sessions, while device login writes only to the protected host cache.
      execOnlyEnv: {
        CODEX_HOME: PROJECT_RUNTIME_SUBSCRIPTION_CODEX_HOME,
      },
      authRuntime,
      touchReason: "codex-device-auth",
      // This is a staging home. The verified lifecycle operation below is the
      // only path allowed to publish it to the account credential registry.
      syncSubscriptionAuthOnExit: false,
    });
  } catch (err) {
    await rm(codexHome, { recursive: true, force: true }).catch(() => {});
    await releaseCodexDeviceAuthLease({ projectId, accountId, leaseId });
    throw err;
  }
  const proc = spawned.proc;
  const session: DeviceAuthSession = {
    id,
    projectId,
    accountId,
    credentialId,
    create,
    codexHome,
    proc,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    state: "pending",
    output: "",
    leaseId,
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
    void cleanupPendingAuthHome(session);
  });
  proc.on("exit", (code, signal) => {
    session.exitCode = code;
    session.signal = signal;
    session.updatedAt = Date.now();
    if (session.state === "canceled") return;
    if (code === 0) {
      session.state = "syncing";
      void touchSubscriptionCacheUsage(session.codexHome).catch((err) => {
        logger.warn("failed to touch local codex subscription cache marker", {
          id,
          projectId,
          accountId,
          err: `${err}`,
        });
      });
      void (async () => {
        try {
          const verification = verifySubscriptionAuth
            ? await verifySubscriptionAuth({
                projectId: session.projectId,
                accountId: session.accountId,
                codexHome: session.codexHome,
                credentialId: session.credentialId,
              })
            : undefined;
          if (sessions.get(session.id)?.state === "canceled") return;
          const result = await pushSubscriptionAuthToRegistry({
            projectId: session.projectId,
            accountId: session.accountId,
            credentialId: session.credentialId,
            create: session.create,
            codexHome: session.codexHome,
            descriptorMetadata: verification?.descriptorMetadata,
          });
          if (sessions.get(session.id)?.state === "canceled") return;
          session.syncedToRegistry = result.ok;
          if (!result.ok) {
            session.state = "failed";
            session.syncError =
              "unable to sync credentials to central registry";
            session.error =
              "ChatGPT sign-in succeeded, but CoCalc could not save the credential. Please try signing in again.";
            session.updatedAt = Date.now();
            return;
          }
          session.credentialId = result.id;
          session.registryCreated = result.created;
          session.syncError = undefined;
          session.state = "completed";
          session.updatedAt = Date.now();
        } catch (err) {
          const current = sessions.get(session.id);
          if (!current || current.state === "canceled") return;
          logger.warn("codex device auth verification failed", {
            id,
            projectId,
            accountId,
            syncedToRegistry: session.syncedToRegistry,
            err: `${err}`,
          });
          session.state = "failed";
          session.syncedToRegistry = session.syncedToRegistry === true;
          session.syncError = `${err}`;
          session.error =
            "ChatGPT sign-in succeeded, but CoCalc could not verify that Codex can use the saved credential. Please try signing in again.";
          session.updatedAt = Date.now();
        } finally {
          await cleanupPendingAuthHome(session);
        }
      })();
    } else {
      session.state = "failed";
      if (!session.error) {
        // Promote common known failures to actionable user-facing errors.
        session.error = classifyDeviceAuthFailure(session.output, code ?? null);
        if (session.error.startsWith("codex login exited")) {
          session.error = `codex login exited with code=${code} signal=${signal}`;
        }
      }
      void cleanupPendingAuthHome(session);
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
    credentialId: session.credentialId,
    create: session.create,
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
    registryCreated: session.registryCreated,
    syncError: session.syncError,
  };
}

export function getCodexDeviceAuthStatus(
  id: string,
): ReturnType<typeof snapshot> | undefined {
  pruneSessions();
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
  void cleanupPendingAuthHome(session);
  return true;
}
