/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isValidUUID } from "@cocalc/util/misc";

const execFileAsync = promisify(execFile);
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;

export type ClaudeSubscriptionLoginStatus = {
  id: string;
  state: "pending" | "verifying" | "completed" | "failed" | "canceled";
  verificationUrl?: string;
  credentialId?: string;
  error?: string;
};

type LoginSession = ClaudeSubscriptionLoginStatus & {
  projectId: string;
  accountId: string;
  home: string;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  output: string;
  codeSubmitted: boolean;
};

function loginEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    NO_BROWSER: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
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
    value?.apiKeySource ||
    typeof plan !== "string" ||
    !/^(?:claude\s+)?(?:pro|max)(?:\s|$)/i.test(plan)
  )
    throw Error("Claude Pro/Max subscription was not verified");
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

  constructor(
    private readonly options: {
      cliPath: string;
      argsPrefix?: string[];
      publish: (options: {
        projectId: string;
        accountId: string;
        home: string;
        identity: string;
        plan: string;
      }) => Promise<string>;
    },
  ) {}

  async start(
    projectId: string,
    accountId: string,
  ): Promise<ClaudeSubscriptionLoginStatus> {
    if (!isValidUUID(projectId) || !isValidUUID(accountId))
      throw Error("Invalid Claude sign-in principal");
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.accountId === accountId &&
          (session.state === "pending" || session.state === "verifying"),
      )
    )
      throw Error("Claude sign-in is already in progress for this account");
    const home = await mkdtemp(join(tmpdir(), "cocalc-claude-login-"));
    const id = randomUUID();
    let child: ChildProcess;
    try {
      child = spawn(
        this.options.cliPath,
        [...(this.options.argsPrefix ?? []), "auth", "login", "--claudeai"],
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
    const timer = setTimeout(
      () => this.cancel(id, projectId, accountId),
      LOGIN_TIMEOUT_MS,
    );
    timer.unref();
    const session: LoginSession = {
      id,
      projectId,
      accountId,
      home,
      child,
      timer,
      state: "pending",
      output: "",
      codeSubmitted: false,
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
    child.once("close", (code) => void this.complete(session, code));
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
    session.child.stdin?.end(`${code}\n`);
  }

  cancel(id: string, projectId: string, accountId: string): void {
    const session = this.required(id, projectId, accountId);
    if (session.state !== "pending" && session.state !== "verifying") return;
    session.state = "canceled";
    clearTimeout(session.timer);
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
      const { stdout } = await execFileAsync(
        this.options.cliPath,
        [...(this.options.argsPrefix ?? []), "auth", "status", "--json"],
        {
          cwd: session.home,
          env: loginEnvironment(session.home),
          timeout: 10_000,
          maxBuffer: MAX_STATUS_BYTES,
        },
      );
      const { plan, identity } = verifiedClaudeSubscriptionStatus(stdout);
      const credentialId = await this.options.publish({
        projectId: session.projectId,
        accountId: session.accountId,
        home: session.home,
        identity,
        plan,
      });
      if (!isValidUUID(credentialId))
        throw Error("Published Claude credential ID is invalid");
      session.credentialId = credentialId;
      session.state = "completed";
    } catch {
      this.fail(session, "Claude subscription verification failed");
    } finally {
      await rm(session.home, { recursive: true, force: true });
    }
  }

  private fail(session: LoginSession, error: string): void {
    if (session.state === "canceled" || session.state === "completed") return;
    clearTimeout(session.timer);
    session.state = "failed";
    session.error = error;
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
