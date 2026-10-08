/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidUUID } from "@cocalc/util/misc";
import { harnessOwner } from "./harness-reaper";
import {
  claudeOAuthTokenFromOutput,
  claudeOAuthTokenLine,
  looksLikeClaudeSecret,
} from "./claude-subscription-token";
import {
  CLAUDE_LOGIN_PREFIX,
  CLAUDE_LOGIN_OWNER,
  killClaudeLoginProcesses,
} from "./claude-login-cleanup";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Claude Code treats a long burst of input as a paste, in which Enter is
// text rather than submit: send Enter on its own after the code.
const ENTER_DELAY_MS = 750;
// Exchanging the code takes seconds; never leave the user waiting forever.
const CODE_EXCHANGE_TIMEOUT_MS = 90_000;
const TERMINAL_STATUS_RETENTION_MS = 15 * 60_000;
// The terminal UI redraws, so keep enough for the token after the art.
const MAX_OUTPUT_BYTES = 64 * 1024;
// setup-token requests a one-year token.
const TOKEN_LIFETIME_MS = 365 * 24 * 3600 * 1000;

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
  // The submitted code, so that its echo is never mistaken for a token.
  code: string;
  completion?: Promise<void>;
};

function loginEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    NO_BROWSER: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
  };
}

// Plain text of terminal output: drop escape sequences and control bytes.
export function terminalText(output: string): string {
  return output
    .replace(/\x1b\[(\d*)C/g, (_, n) =>
      " ".repeat(Math.min(Number(n) || 1, 200)),
    )
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

/** Auth is staged on the host, never in a project mount or model process. */
export class ClaudeSubscriptionLoginService {
  private sessions = new Map<string, LoginSession>();
  private closed = false;
  private starting = new Set<Promise<unknown>>();
  // Starts for one account run one after another, from reconnect validation
  // through session registration, so that the newest start always replaces
  // the older ones. Different accounts start in parallel.
  private accountStarts = new Map<string, Promise<unknown>>();

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        clearTimeout(session.timer);
        if (session.state === "pending") session.state = "canceled";
        // Let an already-admitted publication finish before deleting its input.
        await session.completion;
        await killClaudeLoginProcesses(session.home);
        await rm(session.home, { recursive: true, force: true });
      }),
    );
    this.sessions.clear();
    if (results.some((result) => result.status === "rejected"))
      throw Error("Claude sign-in cleanup failed");
  }

  constructor(
    private readonly options: {
      cliPath: string;
      argsPrefix?: string[];
      // Runs the CLI in a pseudo-terminal: setup-token is a terminal UI.
      scriptPath?: string;
      enterDelayMs?: number;
      exchangeTimeoutMs?: number;
      publish: (options: {
        projectId: string;
        accountId: string;
        token: string;
        expiresAt: string;
        credentialId?: string;
      }) => Promise<string>;
      validateReconnect?: (options: {
        projectId: string;
        accountId: string;
        credentialId: string;
      }) => Promise<unknown>;
    },
  ) {}

  start(
    projectId: string,
    accountId: string,
    credentialId?: string,
  ): Promise<ClaudeSubscriptionLoginStatus> {
    if (this.closed)
      return Promise.reject(Error("Claude sign-in service is closed"));
    const previous = this.accountStarts.get(accountId) ?? Promise.resolve();
    const started = previous
      .catch(() => {})
      .then(() => this.startSession(projectId, accountId, credentialId));
    this.accountStarts.set(accountId, started);
    void started
      .finally(() => {
        if (this.accountStarts.get(accountId) === started)
          this.accountStarts.delete(accountId);
      })
      .catch(() => {});
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
    if (credentialId != null) {
      if (!isValidUUID(credentialId) || !this.options.validateReconnect)
        throw Error("Invalid Claude reconnect request");
      await this.options.validateReconnect({
        projectId,
        accountId,
        credentialId,
      });
    }
    const existing = [...this.sessions.values()].filter(
      (session) => session.accountId === accountId,
    );
    // A submitted code is being exchanged with the provider; let it finish.
    if (
      existing.some(
        (session) =>
          session.state === "verifying" ||
          (session.state === "pending" && session.codeSubmitted),
      )
    )
      throw Error("Claude sign-in is already in progress for this account");
    // A pending sign-in without a submitted code only waits for the user, who
    // abandoned it (e.g. closed the dialog) and cannot get back to it, so a
    // new sign-in replaces it instead of being refused until it times out.
    for (const session of existing) {
      if (session.state === "pending" && !session.codeSubmitted)
        this.cancel(session.id, session.projectId, accountId);
    }
    const home = await mkdtemp(join(tmpdir(), CLAUDE_LOGIN_PREFIX));
    const id = randomUUID();
    let child: ChildProcess;
    try {
      await writeFile(join(home, CLAUDE_LOGIN_OWNER), await harnessOwner(), {
        mode: 0o600,
      });
      if (this.closed) throw Error("Claude sign-in service is closed");
      // A wide terminal keeps the URL and token on single lines; no echo, so
      // the code the user pastes is not printed back.
      const command = [
        this.options.cliPath,
        ...(this.options.argsPrefix ?? []),
        "setup-token",
      ]
        .map(quote)
        .join(" ");
      child = spawn(
        this.options.scriptPath ?? "script",
        [
          "-q",
          "-e",
          "-f",
          "-c",
          `stty cols 4000 rows 40 -echo 2>/dev/null; exec ${command}`,
          "/dev/null",
        ],
        {
          cwd: home,
          env: loginEnvironment(home),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
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
      code: "",
    };
    this.sessions.set(id, session);
    const append = (chunk: Buffer) => {
      if (session.state !== "pending") return;
      session.output = (session.output + chunk.toString("utf8")).slice(
        -MAX_OUTPUT_BYTES,
      );
      const text = terminalText(session.output);
      session.verificationUrl ??= providerUrl(text);
      if (!session.codeSubmitted) return;
      const token = claudeOAuthTokenLine(text, session.code);
      if (token) {
        // Only telemetry and exit remain for the CLI: save the token now.
        session.completion = this.publish(session, token);
        void session.completion.catch(() =>
          this.fail(session, "Claude sign-in cleanup failed"),
        );
        this.kill(session);
        return;
      }
      // The terminal UI waits for a retry instead of exiting on a bad code.
      if (/OAuth\s*error|Invalid\s*code/i.test(text))
        this.fail(
          session,
          "Claude did not accept the code. Copy the whole code and try again.",
        );
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () =>
      this.fail(session, "Claude sign-in could not start"),
    );
    child.once("close", (code) => {
      if (session.state !== "pending") return;
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
    const value = typeof code === "string" ? code.trim() : "";
    if (
      value.length < 4 ||
      value.length > 2048 ||
      /[\s\x00-\x1f\x7f]/.test(value)
    )
      throw Error("Invalid Claude sign-in code");
    // Only a token Claude prints after the exchange is saved, never one pasted.
    if (looksLikeClaudeSecret(value))
      throw Error(
        "That is a Claude token, not a sign-in code. Paste the code Claude shows after you approve.",
      );
    session.codeSubmitted = true;
    session.code = value;
    // Forget the pre-code output so a later match comes from the result.
    session.output = "";
    // Keep stdin open while the terminal UI exchanges the code.
    session.child.stdin?.write(value);
    const enter = setTimeout(() => {
      if (session.state === "pending") session.child.stdin?.write("\r");
    }, this.options.enterDelayMs ?? ENTER_DELAY_MS);
    enter.unref();
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.state === "pending")
        this.fail(
          session,
          "Claude did not finish signing in. Start the sign-in again.",
        );
    }, this.options.exchangeTimeoutMs ?? CODE_EXCHANGE_TIMEOUT_MS);
    session.timer.unref();
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

  private complete(session: LoginSession, code: number | null) {
    if (session.state !== "pending") return Promise.resolve();
    // The CLI exited: its output is complete, so a token cannot be partial.
    const token = session.codeSubmitted
      ? claudeOAuthTokenFromOutput(terminalText(session.output), session.code)
      : undefined;
    if (code !== 0 || !token) {
      this.fail(session, "Claude sign-in did not complete");
      return Promise.resolve();
    }
    return this.publish(session, token);
  }

  private async publish(session: LoginSession, token: string) {
    clearTimeout(session.timer);
    session.state = "verifying";
    try {
      if (this.closed) throw Error("Claude sign-in service is closed");
      const credentialId = await this.options.publish({
        projectId: session.projectId,
        accountId: session.accountId,
        token,
        expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
        ...(session.reconnectCredentialId
          ? { credentialId: session.reconnectCredentialId }
          : {}),
      });
      if (!isValidUUID(credentialId))
        throw Error("Published Claude credential ID is invalid");
      session.credentialId = credentialId;
      session.state = "completed";
      this.retire(session);
    } catch {
      this.fail(session, "Claude subscription could not be saved");
    } finally {
      session.output = "";
      session.code = "";
      await rm(session.home, { recursive: true, force: true });
    }
  }

  private fail(session: LoginSession, error: string): void {
    if (session.state === "canceled" || session.state === "completed") return;
    clearTimeout(session.timer);
    session.state = "failed";
    session.error = error;
    session.code = "";
    this.retire(session);
    this.removeHomeAfterExit(session);
    this.kill(session);
  }

  private removeHomeAfterExit(session: LoginSession): void {
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      void rm(session.home, { recursive: true, force: true });
    } else {
      session.child.once("close", () => {
        void rm(session.home, { recursive: true, force: true });
      });
    }
  }

  private kill(session: LoginSession): void {
    if (!session.child.pid) return;
    try {
      process.kill(-session.child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
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
