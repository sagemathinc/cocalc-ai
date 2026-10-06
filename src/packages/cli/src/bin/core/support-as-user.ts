/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// `cocalc admin support as-user`: run one inspection command as a support
// ticket's user. This is the CLI analogue of opening a support impersonation
// link in a fresh incognito window: the audited grant is redeemed with plain
// HTTP (no browser, no site JavaScript), the session cookie only ever lives in
// memory and a private temporary file, the command runs in a separate CLI
// process that cannot fall back to the operator's credentials, and the session
// is signed out afterwards.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inspection commands only. `project exec` runs arbitrary code as the user, so
// operators must keep it to read-only commands (du, ls, ...); everything is
// still limited to the user's own permissions and the audited grant.
const ALLOWED_COMMANDS: readonly string[][] = [
  ["project", "exec"],
  ["project", "list"],
  ["project", "status"],
  ["project", "storage", "show"],
  ["project", "storage", "breakdown"],
  ["project", "storage", "history"],
  ["project", "snapshot", "list"],
  ["project", "backup", "list"],
  ["project", "backup", "files"],
  ["project", "file", "list"],
  ["project", "file", "cat"],
  ["project", "file", "rg"],
  ["project", "file", "fd"],
];

const FORBIDDEN_GLOBAL_FLAGS = new Set([
  "--cookie",
  "--cookie-file",
  "--api-key",
  "--api-key-file",
  "--bearer",
  "--hub-password",
  "--profile",
  "--api",
  "--account-id",
]);

export function allowedAsUserCommand(args: readonly string[]): boolean {
  if (args.some((arg) => FORBIDDEN_GLOBAL_FLAGS.has(arg.split("=")[0]))) {
    return false;
  }
  const words = args.filter((arg) => !arg.startsWith("-"));
  return ALLOWED_COMMANDS.some((prefix) =>
    prefix.every((word, i) => words[i] === word),
  );
}

export function allowedAsUserCommandsHelp(): string {
  return ALLOWED_COMMANDS.map((words) => words.join(" ")).join(", ");
}

/** Cookie name -> value from Set-Cookie headers (later wins). */
function collectCookies(headers: Headers, jar: Map<string, string>): void {
  const values =
    typeof (headers as any).getSetCookie === "function"
      ? ((headers as any).getSetCookie() as string[])
      : `${headers.get("set-cookie") ?? ""}`.split(/,(?=[^;]+=)/);
  for (const raw of values) {
    const pair = raw.split(";", 1)[0] ?? "";
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) continue;
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function hasSession(jar: Map<string, string>): boolean {
  return [...jar.keys()].some((name) => name.endsWith("remember_me"));
}

// The cross-bay retry is a client-side redirect page. Accept only another
// https /auth/impersonate URL from it.
function clientSideImpersonationRedirect(html: string): URL | undefined {
  const match = html.match(/window\.location\.href\s*=\s*("(?:[^"\\]|\\.)*")/);
  if (!match) return undefined;
  try {
    const url = new URL(JSON.parse(match[1]));
    if (url.protocol !== "https:" && url.hostname !== "localhost") return;
    if (!url.pathname.endsWith("/auth/impersonate")) return;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Redeem an impersonation link without a browser. Returns the Cookie header
 * and the origin that issued the session (the subject's home bay).
 */
export async function redeemImpersonationUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cookie: string; origin: string }> {
  const jar = new Map<string, string>();
  let target: URL | undefined = new URL(url);
  target.searchParams.set("confirm", "1");
  for (let hop = 0; target && hop < 3; hop++) {
    const response = await fetchImpl(target, {
      redirect: "manual",
      headers: jar.size ? { cookie: cookieHeader(jar) } : {},
    });
    collectCookies(response.headers, jar);
    const body = await response.text();
    if (hasSession(jar)) {
      return { cookie: cookieHeader(jar), origin: target.origin };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      target = location ? new URL(location, target) : undefined;
      if (target && !target.pathname.endsWith("/auth/impersonate")) {
        target = undefined;
      }
      continue;
    }
    if (/ERROR: impersonate error/.test(body)) {
      throw new Error(
        body
          .replace(/<[^>]*>/g, "")
          .trim()
          .slice(0, 300),
      );
    }
    target = clientSideImpersonationRedirect(body);
  }
  throw new Error("impersonation link did not establish a session");
}

/** Revoke only this session (never "all"). */
export async function signOutSession(
  api: string,
  cookie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      new URL("api/v2/accounts/sign-out", api.endsWith("/") ? api : `${api}/`),
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        // `all: false` revokes only this session, never the user's others.
        body: JSON.stringify({ all: false }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export interface AsUserRunResult {
  exit_code: number | null;
  stdout: unknown;
  stderr: string;
  truncated: boolean;
}

/** Run one CLI command as the user in a separate process. */
export async function runCliAsUser({
  api,
  accountId,
  cookie,
  args,
  timeoutMs,
  maxBytes = 1024 * 1024,
}: {
  api: string;
  accountId: string;
  cookie: string;
  args: readonly string[];
  timeoutMs: number;
  maxBytes?: number;
}): Promise<AsUserRunResult> {
  const dir = await mkdtemp(join(tmpdir(), "cocalc-as-user-"));
  const cookieFile = join(dir, "cookie");
  try {
    await writeFile(cookieFile, cookie, { mode: 0o600, flag: "wx" });
    const entry = process.argv[1];
    const prefix = entry && /\.[cm]?js$/.test(entry) ? [entry] : [];
    const child = spawn(
      process.execPath,
      [
        ...prefix,
        "--no-daemon",
        "--json",
        "--cookie-file",
        cookieFile,
        "--api",
        api,
        "--account-id",
        accountId,
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/^COCALC_(API_KEY|HUB_PASSWORD|ACCOUNT_ID|AGENT|BEARER|PROJECT_ID|API_URL|AUTH)/.test(
                key,
              ),
          ),
        ),
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (target: Buffer[]) => (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) {
        truncated = true;
        chunk = chunk.subarray(0, Math.max(0, maxBytes - size));
      }
      size += chunk.length;
      if (chunk.length) target.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const text = Buffer.concat(out).toString("utf8");
    let stdout: unknown = text;
    try {
      stdout = JSON.parse(text);
    } catch {
      // keep text
    }
    return {
      exit_code: exitCode,
      stdout,
      stderr: Buffer.concat(err).toString("utf8").slice(0, 20_000),
      truncated,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
