/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// `cocalc admin support as-user`: run one inspection command as a support
// ticket's user. This is the CLI analogue of opening a support impersonation
// link in a fresh incognito window: the audited grant is redeemed with plain
// HTTP (no browser, no site JavaScript), the session cookie only ever lives in
// memory and is handed to the child over stdin, the command runs in a separate CLI
// process that cannot fall back to the operator's credentials, and the session
// is signed out afterwards.

import { spawn } from "node:child_process";

// Read-only inspection commands, matched exactly: the argv must start with
// the command words, and every later token must be one of that command's
// listed options (with its value) or a positional argument. No root/global
// options, no "--", and no pass-through options such as rg/fd extra flags
// (ripgrep --pre and fd --exec run programs). There is deliberately no
// arbitrary shell (project exec).
interface AsUserCommand {
  words: string[];
  /** option -> number of values it takes */
  options: Record<string, 0 | 1>;
  maxPositionals: number;
}

const PROJECT = { "-w": 1, "--project": 1 } as const;

const ALLOWED_COMMANDS: readonly AsUserCommand[] = [
  {
    words: ["project", "list"],
    options: { "--host": 1, "--prefix": 1, "--limit": 1 },
    maxPositionals: 0,
  },
  { words: ["project", "status"], options: { ...PROJECT }, maxPositionals: 0 },
  {
    words: ["project", "storage", "show"],
    options: { ...PROJECT, "--home": 1 },
    maxPositionals: 0,
  },
  {
    words: ["project", "storage", "breakdown"],
    options: { ...PROJECT },
    maxPositionals: 1,
  },
  {
    words: ["project", "storage", "history"],
    options: { ...PROJECT, "--window": 1, "--points": 1 },
    maxPositionals: 0,
  },
  {
    words: ["project", "snapshot", "list"],
    options: { ...PROJECT },
    maxPositionals: 0,
  },
  {
    words: ["project", "backup", "list"],
    options: { ...PROJECT, "--indexed-only": 0, "--limit": 1 },
    maxPositionals: 0,
  },
  {
    words: ["project", "backup", "files"],
    options: { ...PROJECT, "--backup-id": 1, "--path": 1 },
    maxPositionals: 0,
  },
  {
    words: ["project", "file", "list"],
    options: { ...PROJECT },
    maxPositionals: 1,
  },
  {
    words: ["project", "file", "cat"],
    options: { ...PROJECT },
    maxPositionals: 1,
  },
  {
    words: ["project", "file", "rg"],
    options: { ...PROJECT, "--timeout": 1, "--max-bytes": 1 },
    maxPositionals: 2,
  },
  {
    words: ["project", "file", "fd"],
    options: { ...PROJECT },
    maxPositionals: 2,
  },
];

export function allowedAsUserCommand(args: readonly string[]): boolean {
  const spec = ALLOWED_COMMANDS.find(({ words }) =>
    words.every((word, i) => args[i] === word),
  );
  if (!spec) return false;
  let positionals = 0;
  for (let i = spec.words.length; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (arg.startsWith("-")) {
      // Values must be separate tokens; "--opt=value" and bundled short
      // flags are rejected rather than interpreted.
      const arity = Object.prototype.hasOwnProperty.call(spec.options, arg)
        ? spec.options[arg]
        : undefined;
      if (arity == null) return false;
      if (arity === 1) {
        const value = args[i + 1];
        if (value == null) return false;
        i += 1;
      }
    } else {
      positionals += 1;
      if (positionals > spec.maxPositionals) return false;
    }
  }
  return true;
}

export function allowedAsUserCommandsHelp(): string {
  return ALLOWED_COMMANDS.map(({ words }) => words.join(" ")).join(", ");
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

// The cross-bay retry is a client-side redirect page. Accept only an
// /auth/impersonate URL on one of the grant's own origins.
function clientSideImpersonationRedirect(
  html: string,
  allowedOrigins: ReadonlySet<string>,
): URL | undefined {
  const match = html.match(/window\.location\.href\s*=\s*("(?:[^"\\]|\\.)*")/);
  if (!match) return undefined;
  try {
    const url = new URL(JSON.parse(match[1]));
    if (!allowedOrigins.has(url.origin)) return;
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
  /** Origins the redemption may visit, e.g. the grant's and its home bay's. */
  extraOrigins: readonly string[] = [],
): Promise<{ cookie: string; origin: string }> {
  const jar = new Map<string, string>();
  let target: URL | undefined = new URL(url);
  const allowedOrigins = new Set([
    target.origin,
    ...extraOrigins.flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    }),
  ]);
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
      if (
        target &&
        (!allowedOrigins.has(target.origin) ||
          !target.pathname.endsWith("/auth/impersonate"))
      ) {
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
    target = clientSideImpersonationRedirect(body, allowedOrigins);
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
        signal: AbortSignal.timeout(10_000),
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
  expectedAccountId,
  cookie,
  args,
  timeoutMs,
  maxBytes = 1024 * 1024,
}: {
  api: string;
  /** The child must be authenticated as exactly this account. */
  expectedAccountId: string;
  cookie: string;
  args: readonly string[];
  timeoutMs: number;
  maxBytes?: number;
}): Promise<AsUserRunResult> {
  const entry = process.argv[1];
  const prefix = entry && /\.[cm]?js$/.test(entry) ? [entry] : [];
  // The cookie goes over stdin ("--cookie-file -"): never argv, never disk.
  // No --account-id: the account comes from the session, and is checked.
  const child = spawn(
    process.execPath,
    [
      ...prefix,
      "--no-daemon",
      "--json",
      "--cookie-file",
      "-",
      "--api",
      api,
      ...args,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
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
  child.stdin.end(cookie);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const parse = (text: string): any => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const stdoutText = Buffer.concat(out).toString("utf8");
  const stderrText = Buffer.concat(err).toString("utf8");
  const parsed = parse(stdoutText) ?? parse(stderrText);
  const actual = parsed?.meta?.account_id;
  if (actual !== expectedAccountId) {
    throw new Error(
      `as-user session was not verified as the requested account (got ${actual ?? "none"}); output withheld`,
    );
  }
  return {
    exit_code: exitCode,
    stdout: parse(stdoutText) ?? stdoutText,
    stderr: stderrText.slice(0, 20_000),
    truncated,
  };
}
