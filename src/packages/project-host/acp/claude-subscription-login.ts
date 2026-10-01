/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { isValidUUID } from "@cocalc/util/misc";
import {
  isSupportedClaudeSubscriptionPlan,
  CLAUDE_SUBSCRIPTION_PLAN_ERROR,
} from "@cocalc/util/ai/claude-subscription-plan";
import { harnessOwner } from "./harness-reaper";
import {
  CLAUDE_LOGIN_PREFIX,
  CLAUDE_LOGIN_OWNER,
  CLAUDE_LOGIN_RECOVERY,
  type ClaudeLoginRecovery,
} from "./claude-login-cleanup";
import { createClaudeLoginRuntime } from "./claude-login-runtime";
import type {
  ClaudeLoginRuntime,
  ClaudeLoginRuntimeBinding,
} from "./claude-login-runtime";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_STATUS_RETENTION_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export type ClaudeSubscriptionLoginStatus = {
  id: string;
  state: "pending" | "verifying" | "completed" | "failed" | "canceled";
  verificationUrl?: string;
  credentialId?: string;
  error?: string;
};

type LoginSession = ClaudeSubscriptionLoginStatus & {
  reconnectCredentialId?: string;
  projectId: string;
  accountId: string;
  home: string;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  output: string;
  codeSubmitted: boolean;
  completion?: Promise<void>;
  releaseOwnership?: () => Promise<void>;
  recovery?: ClaudeLoginRecovery;
  binding: ClaudeLoginRuntimeBinding;
  cleanup?: Promise<void>;
};

function providerUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/[^\s<>"']+(?=\s)/);
  if (!match) return;
  try {
    const url = new URL(match[0]);
    if (
      url.protocol === "https:" &&
      (url.hostname === "claude.com" || url.hostname === "platform.claude.com")
    )
      return url.toString();
  } catch {
    // Incomplete output is normal while the CLI is still writing.
  }
}

export function verifiedClaudeSubscriptionStatus(output: string): {
  plan: string;
  identity: string;
} {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(output);
  } catch {
    throw Error("Claude subscription status could not be verified");
  }
  const plan = value?.subscriptionType;
  if (
    value?.loggedIn !== true ||
    value?.apiProvider !== "firstParty" ||
    value?.apiKeySource
  )
    throw Error("Claude Pro/Max subscription was not verified");
  if (!isSupportedClaudeSubscriptionPlan(plan))
    throw Error(CLAUDE_SUBSCRIPTION_PLAN_ERROR);
  const identity = value.email;
  if (
    typeof identity !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity) ||
    identity.length > 320
  )
    throw Error("Claude account identity was not verified");
  return { plan, identity };
}

/** Auth is staged on the host, never in a project mount or model process. */
export class ClaudeSubscriptionLoginService {
  private sessions = new Map<string, LoginSession>();
  private closed = false;
  private starting = new Set<Promise<unknown>>();
  private readonly runtime: ClaudeLoginRuntime;

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        clearTimeout(session.timer);
        if (session.state === "pending") session.state = "canceled";
        // Let an already-admitted publication finish before deleting its input.
        await session.completion;
        this.kill(session);
        await this.cleanup(session);
      }),
    );
    this.sessions.clear();
    if (results.some((result) => result.status === "rejected"))
      throw Error("Claude sign-in cleanup failed");
  }

  constructor(
    private readonly options: {
      cliPath: string;
      runtime?: ClaudeLoginRuntime;
      publish: (options: {
        projectId: string;
        accountId: string;
        home: string;
        identity: string;
        plan: string;
        credentialId?: string;
        controllerHolder?: string;
      }) => Promise<string>;
      validateReconnect?: (options: {
        projectId: string;
        accountId: string;
        credentialId: string;
      }) => Promise<unknown>;
      reserveReconnect?: (options: {
        projectId: string;
        accountId: string;
        credentialId?: string;
        holder: string;
      }) => Promise<() => Promise<void>>;
      existingCredential?: (options: {
        projectId: string;
        accountId: string;
      }) => Promise<string | undefined>;
    },
  ) {
    this.runtime = options.runtime ?? createClaudeLoginRuntime(options.cliPath);
  }

  start(
    projectId: string,
    accountId: string,
    credentialId?: string,
  ): Promise<ClaudeSubscriptionLoginStatus> {
    if (this.closed)
      return Promise.reject(Error("Claude sign-in service is closed"));
    const started = this.startSession(projectId, accountId, credentialId);
    this.starting.add(started);
    void started.finally(() => this.starting.delete(started)).catch(() => {});
    return started;
  }

  private async startSession(
    projectId: string,
    accountId: string,
    credentialId?: string,
  ): Promise<ClaudeSubscriptionLoginStatus> {
    if (!isValidUUID(projectId) || !isValidUUID(accountId))
      throw Error("Invalid Claude sign-in principal");
    credentialId ??= await this.options.existingCredential?.({
      projectId,
      accountId,
    });
    if (credentialId != null) {
      if (!isValidUUID(credentialId) || !this.options.validateReconnect)
        throw Error("Invalid Claude reconnect request");
      await this.options.validateReconnect({
        projectId,
        accountId,
        credentialId,
      });
    }
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.accountId === accountId &&
          (session.state === "pending" || session.state === "verifying"),
      )
    )
      throw Error("Claude sign-in is already in progress for this account");
    const runtimeId = await harnessOwner();
    const home = await mkdtemp(join(tmpdir(), CLAUDE_LOGIN_PREFIX));
    const id = randomUUID();
    let child: ChildProcess;
    let releaseOwnership: (() => Promise<void>) | undefined;
    const binding = {
      projectId,
      holder: id,
      home,
      runtimeId,
    };
    const recovery: ClaudeLoginRecovery | undefined = this.options
      .reserveReconnect
      ? {
          projectId,
          accountId,
          credentialId,
          holder: id,
          codeSubmitted: false,
          published: false,
          containment: "podman-v1",
          nativeStarted: false,
        }
      : undefined;
    try {
      const runtimeId = binding.runtimeId;
      if (recovery) recovery.runtimeId = runtimeId;
      await writeFile(join(home, CLAUDE_LOGIN_OWNER), runtimeId, {
        mode: 0o600,
      });
      if (recovery)
        writeFileSync(
          join(home, CLAUDE_LOGIN_RECOVERY),
          JSON.stringify(recovery),
          { mode: 0o600 },
        );
      releaseOwnership = await this.options.reserveReconnect?.({
        projectId,
        accountId,
        credentialId,
        holder: id,
      });
      if (this.closed) throw Error("Claude sign-in service is closed");
      await mkdir(join(home, "native"), { mode: 0o700 });
      if (recovery) {
        recovery.nativeStarted = true;
        writeFileSync(
          join(home, CLAUDE_LOGIN_RECOVERY),
          JSON.stringify(recovery),
          { mode: 0o600 },
        );
      }
      child = await this.runtime.launch(binding);
    } catch (error) {
      if (recovery) {
        recovery.abandoned = true;
        writeFileSync(
          join(home, CLAUDE_LOGIN_RECOVERY),
          JSON.stringify(recovery),
          { mode: 0o600 },
        );
        // The reaper retires even an acquisition with an unknown acknowledgement.
      }
      // A failed launch acknowledgement does not prove the container is absent.
      if (!recovery || recovery.nativeStarted) await this.runtime.stop(binding);
      await releaseOwnership?.();
      if (!recovery || releaseOwnership)
        await rm(home, { recursive: true, force: true });
      throw error;
    }
    const timer = setTimeout(() => {
      if (session.state === "pending") this.cancel(id, projectId, accountId);
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
    const session: LoginSession = {
      id,
      reconnectCredentialId: credentialId,
      projectId,
      accountId,
      home,
      child,
      timer,
      state: "pending",
      output: "",
      codeSubmitted: false,
      releaseOwnership,
      recovery,
      binding,
    };
    this.sessions.set(id, session);
    const append = (chunk: Buffer) => {
      if (session.state !== "pending") return;
      session.output = (session.output + chunk.toString("utf8")).slice(
        -MAX_OUTPUT_BYTES,
      );
      session.verificationUrl ??= providerUrl(session.output);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () =>
      this.fail(session, "Claude sign-in could not start"),
    );
    child.once("close", (code) => {
      session.completion = this.complete(session, code);
      void session.completion.catch(() =>
        this.fail(session, "Claude sign-in cleanup failed"),
      );
    });
    return this.snapshot(session);
  }

  status(
    id: string,
    projectId: string,
    accountId: string,
  ): ClaudeSubscriptionLoginStatus {
    return this.snapshot(this.required(id, projectId, accountId));
  }

  submitCode(
    id: string,
    projectId: string,
    accountId: string,
    code: string,
  ): void {
    const session = this.required(id, projectId, accountId);
    if (
      session.state !== "pending" ||
      session.codeSubmitted ||
      !session.verificationUrl
    )
      throw Error("Claude sign-in is not awaiting a code");
    if (
      typeof code !== "string" ||
      code.length < 4 ||
      code.length > 2048 ||
      /[\r\n\x00-\x1f\x7f]/.test(code)
    )
      throw Error("Invalid Claude sign-in code");
    session.codeSubmitted = true;
    if (session.recovery) {
      session.recovery.codeSubmitted = true;
      this.saveRecovery(session);
    }
    session.child.stdin?.end(`${code}\n`);
  }

  cancel(id: string, projectId: string, accountId: string): void {
    const session = this.required(id, projectId, accountId);
    if (session.state === "verifying")
      throw Error("Claude sign-in verification is already in progress");
    if (session.state === "completed")
      throw Error("Claude sign-in has already completed");
    if (session.state !== "pending") return;
    session.state = "canceled";
    clearTimeout(session.timer);
    this.retire(session);
    this.removeHomeAfterExit(session);
    this.kill(session);
  }

  private async complete(session: LoginSession, code: number | null) {
    if (session.state !== "pending") return;
    clearTimeout(session.timer);
    if (code !== 0) {
      this.fail(session, "Claude sign-in did not complete");
      return;
    }
    session.state = "verifying";
    try {
      const stdout = await this.runtime.status(session.binding);
      const { plan, identity } = verifiedClaudeSubscriptionStatus(stdout);
      // Snapshot only after all login/status descendants have stopped rotating files.
      await this.runtime.stop(session.binding);
      if (this.closed) throw Error("Claude sign-in service is closed");
      const credentialId = await this.options.publish({
        projectId: session.projectId,
        accountId: session.accountId,
        home: join(session.home, "native"),
        identity,
        plan,
        credentialId: session.reconnectCredentialId,
        ...(session.releaseOwnership ? { controllerHolder: session.id } : {}),
      });
      if (!isValidUUID(credentialId))
        throw Error("Published Claude credential ID is invalid");
      session.credentialId = credentialId;
      if (session.recovery) {
        session.recovery.published = true;
        this.saveRecovery(session);
      }
      await session.releaseOwnership?.();
      session.releaseOwnership = undefined;
      session.state = "completed";
      await rm(session.home, { recursive: true, force: true });
      this.retire(session);
    } catch (error) {
      this.fail(
        session,
        session.reconnectCredentialId &&
          error instanceof Error &&
          error.message === "Reconnect must use the same Claude account"
          ? "Sign in with the same Claude account to reconnect. Your existing connection was not changed."
          : "Claude subscription verification failed",
      );
    }
  }

  private fail(session: LoginSession, error: string): void {
    if (session.state === "canceled" || session.state === "completed") return;
    clearTimeout(session.timer);
    session.state = "failed";
    session.error = error;
    this.retire(session);
    this.removeHomeAfterExit(session);
    this.kill(session);
  }

  private removeHomeAfterExit(session: LoginSession): void {
    void this.cleanup(session).catch(() => {});
  }

  private cleanup(session: LoginSession): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      if (session.recovery && session.releaseOwnership) {
        session.recovery.abandoned = true;
        this.saveRecovery(session);
      }
      await this.runtime.stop(session.binding);
      // A failed code exchange may have issued a new credential that was not
      // published. Quarantine that owner rather than guessing token validity.
      if (!session.codeSubmitted || session.recovery?.published) {
        await session.releaseOwnership?.();
        session.releaseOwnership = undefined;
      }
      if (session.recovery && session.releaseOwnership) {
        session.recovery.abandoned = true;
        this.saveRecovery(session);
      } else await rm(session.home, { recursive: true, force: true });
    })();
    return session.cleanup;
  }

  private kill(session: LoginSession): void {
    if (
      !session.child.pid ||
      session.child.exitCode != null ||
      session.child.signalCode != null
    )
      return;
    try {
      process.kill(-session.child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private saveRecovery(session: LoginSession): void {
    writeFileSync(
      join(session.home, CLAUDE_LOGIN_RECOVERY),
      JSON.stringify(session.recovery),
      { mode: 0o600 },
    );
  }

  private retire(session: LoginSession): void {
    const timer = setTimeout(
      () => this.sessions.delete(session.id),
      TERMINAL_STATUS_RETENTION_MS,
    );
    timer.unref();
  }

  private required(
    id: string,
    projectId: string,
    accountId: string,
  ): LoginSession {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.projectId !== projectId ||
      session.accountId !== accountId
    )
      throw Error("Unknown Claude sign-in session");
    return session;
  }

  private snapshot(session: LoginSession): ClaudeSubscriptionLoginStatus {
    return {
      id: session.id,
      state: session.state,
      ...(session.verificationUrl
        ? { verificationUrl: session.verificationUrl }
        : {}),
      ...(session.credentialId ? { credentialId: session.credentialId } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }
}
