/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCookieFile, resolveCookieFileGlobals } from "./cookie-file";
import {
  allowedAsUserCommand,
  redeemImpersonationUrl,
  runCliAsUser,
  signOutSession,
} from "./support-as-user";

function response(
  body: string,
  { status = 200, cookies = [] as string[], location = "" } = {},
) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  if (location) headers.set("location", location);
  return new Response(body, { status, headers });
}

test("as-user allows only exact inspection commands with their own options", () => {
  assert.ok(allowedAsUserCommand(["project", "snapshot", "list", "-w", "p"]));
  assert.ok(
    allowedAsUserCommand([
      "project",
      "storage",
      "breakdown",
      "-w",
      "p",
      ".local",
    ]),
  );
  assert.ok(
    allowedAsUserCommand(["project", "file", "cat", "--project", "p", "a.txt"]),
  );
  assert.ok(
    allowedAsUserCommand(["project", "file", "rg", "-w", "p", "TODO", "src"]),
  );
  assert.ok(allowedAsUserCommand(["project", "list", "--limit", "5"]));
});

test("as-user rejects shells, writes and option-operand smuggling", () => {
  const rejected: string[][] = [
    // no arbitrary shell
    ["project", "exec", "-w", "p", "--bash", "du -sh ~"],
    // root option consuming "project" as its value would run `cocalc exec`
    ["--output", "project", "exec", "return 1"],
    ["--json", "project", "list"],
    // writes and restores
    ["project", "file", "rm", "x"],
    ["project", "snapshot", "restore", "-w", "p"],
    ["admin", "support", "list"],
    // pass-through options that can run programs (rg --pre, fd --exec)
    ["project", "file", "rg", "-w", "p", "--rg-option", "--pre=sh", "x"],
    ["project", "file", "fd", "-w", "p", "--exec", "rm"],
    // credential/profile overrides, --opt=value, separators, extra operands
    ["project", "list", "--cookie", "x"],
    ["project", "list", "--profile", "prod"],
    ["project", "status", "--project=p"],
    ["project", "status", "--", "exec"],
    ["project", "status", "-w"],
    ["project", "file", "cat", "-w", "p", "a", "b"],
    ["project", "storage", "show", "--force-sample"],
    [],
  ];
  for (const args of rejected) {
    assert.equal(allowedAsUserCommand(args), false, JSON.stringify(args));
  }
});

test("redeems the confirmation URL with plain HTTP and keeps only cookies", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: URL) => {
    seen.push(url.toString());
    return response('<script>window.location.href = "/app";</script>', {
      cookies: [
        "account_id=acct; Path=/; HttpOnly",
        "remember_me=secret-session; Path=/; HttpOnly; Secure",
      ],
    });
  }) as unknown as typeof fetch;
  const { cookie, origin } = await redeemImpersonationUrl(
    "https://cocalc.ai/auth/impersonate?grant_id=g&account_id=a",
    fakeFetch,
  );
  assert.equal(new URL(seen[0]).searchParams.get("confirm"), "1");
  assert.equal(cookie, "account_id=acct; remember_me=secret-session");
  assert.equal(origin, "https://cocalc.ai");
});

test("follows the cross-bay retry to the home bay only", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: URL) => {
    seen.push(url.toString());
    if (url.hostname === "cocalc.ai") {
      return response(
        `<script>window.location.href = ${JSON.stringify("https://bay-1.cocalc.ai/auth/impersonate?retry_token=t&grant_id=g")};</script>`,
      );
    }
    return response("ok", {
      cookies: ["cocalc_ai_remember_me=bay1-session; Path=/"],
    });
  }) as unknown as typeof fetch;
  const result = await redeemImpersonationUrl(
    "https://cocalc.ai/auth/impersonate?grant_id=g",
    fakeFetch,
    ["https://bay-1.cocalc.ai"],
  );
  assert.equal(seen.length, 2);
  assert.equal(result.origin, "https://bay-1.cocalc.ai");
  assert.equal(result.cookie, "cocalc_ai_remember_me=bay1-session");

  const evil = (async () =>
    response(
      `<script>window.location.href = "https://evil.example/steal";</script>`,
    )) as unknown as typeof fetch;
  await assert.rejects(
    redeemImpersonationUrl("https://cocalc.ai/auth/impersonate?g=1", evil),
    /did not establish a session/,
  );
  // An HTTPS /auth/impersonate URL on an unexpected origin is not followed.
  const otherSite = (async (url: URL) =>
    url.hostname === "cocalc.ai"
      ? response(
          `<script>window.location.href = "https://evil.example/auth/impersonate?x=1";</script>`,
        )
      : response("ok", {
          cookies: ["remember_me=stolen; Path=/"],
        })) as unknown as typeof fetch;
  await assert.rejects(
    redeemImpersonationUrl(
      "https://cocalc.ai/auth/impersonate?g=1",
      otherSite,
      ["https://bay-1.cocalc.ai"],
    ),
    /did not establish a session/,
  );
});

test("reports impersonation errors from the server", async () => {
  const fakeFetch = (async () =>
    response(
      "ERROR: impersonate error -- invalid or expired impersonation grant",
    )) as unknown as typeof fetch;
  await assert.rejects(
    redeemImpersonationUrl("https://cocalc.ai/auth/impersonate?g=1", fakeFetch),
    /expired impersonation grant/,
  );
});

test("signs out only the impersonation session", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    request = { url: url.toString(), init };
    return response("{}");
  }) as unknown as typeof fetch;
  assert.equal(
    await signOutSession("https://cocalc.ai", "remember_me=s", fakeFetch),
    true,
  );
  assert.equal(request!.url, "https://cocalc.ai/api/v2/accounts/sign-out");
  assert.equal(request!.init.body, JSON.stringify({ all: false }));
  assert.ok(request!.init.signal, "sign-out must be time-bounded");
  assert.deepEqual(request!.init.headers, {
    cookie: "remember_me=s",
    "content-type": "application/json",
  });
});

test("cookie files must be private and replace every other credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cookie-file-test-"));
  const path = join(dir, "cookie");
  await writeFile(path, "remember_me=s\n", { mode: 0o600 });
  assert.equal(readCookieFile(path), "remember_me=s");
  const globals = resolveCookieFileGlobals({
    cookieFile: path,
    profile: "prod",
    bearer: "b",
  });
  assert.equal(globals.cookie, "remember_me=s");
  assert.equal(globals.profile, "_env");
  assert.equal(globals.bearer, undefined);
  assert.equal(globals.disableEnvAuthDefaults, true);
  await chmod(path, 0o644);
  assert.throws(() => readCookieFile(path), /must be private/);
  assert.throws(
    () => resolveCookieFileGlobals({ cookieFile: path, cookie: "x" }),
    /without --cookie/,
  );
});

// A stand-in CLI: reports whether the cookie arrived on stdin (and not in
// argv), and claims whichever account the test asks for.
async function fakeCli(accountId: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
  const path = join(dir, "fake-cli.js");
  await writeFile(
    path,
    `const stdin = require("fs").readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const cookieIndex = argv.indexOf("--cookie-file");
console.log(JSON.stringify({
  ok: true,
  data: {
    stdin,
    cookie_file_arg: argv[cookieIndex + 1],
    cookie_in_argv: argv.some((a) => a.includes("remember_me=secret")),
    account_id_flag: argv.includes("--account-id"),
    args: argv.slice(argv.indexOf("--api") + 2),
  },
  meta: { account_id: ${JSON.stringify(accountId)} },
}));
`,
  );
  return path;
}

test("runCliAsUser sends the cookie over stdin and verifies the session account", async () => {
  const result = await runCliAsUser({
    api: "https://cocalc.ai",
    expectedAccountId: "subject",
    cookie: "remember_me=secret",
    args: ["project", "list"],
    timeoutMs: 20_000,
    cliEntry: await fakeCli("subject"),
  });
  const data = (result.stdout as any).data;
  assert.equal(result.exit_code, 0);
  assert.equal(data.stdin, "remember_me=secret");
  assert.equal(data.cookie_file_arg, "-");
  assert.equal(data.cookie_in_argv, false);
  assert.equal(data.account_id_flag, false);
  assert.deepEqual(data.args, ["project", "list"]);
});

test("runCliAsUser withholds output unless the session is the subject", async () => {
  for (const claimed of ["someone-else", null]) {
    await assert.rejects(
      runCliAsUser({
        api: "https://cocalc.ai",
        expectedAccountId: "subject",
        cookie: "remember_me=secret",
        args: ["project", "list"],
        timeoutMs: 20_000,
        cliEntry: await fakeCli(claimed),
      }),
      /not verified as the requested account.*output withheld/,
    );
  }
});
