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

test("as-user allows only inspection commands without credential overrides", () => {
  assert.ok(
    allowedAsUserCommand(["project", "exec", "-w", "p", "--bash", "du -sh ~"]),
  );
  assert.ok(allowedAsUserCommand(["project", "snapshot", "list", "-w", "p"]));
  assert.ok(allowedAsUserCommand(["project", "file", "cat", "a.txt"]));
  assert.equal(allowedAsUserCommand(["project", "file", "rm", "x"]), false);
  assert.equal(allowedAsUserCommand(["project", "snapshot", "restore"]), false);
  assert.equal(allowedAsUserCommand(["admin", "support", "list"]), false);
  assert.equal(
    allowedAsUserCommand(["--profile", "prod", "project", "list"]),
    false,
  );
  assert.equal(allowedAsUserCommand(["project", "list", "--cookie=x"]), false);
  assert.equal(allowedAsUserCommand([]), false);
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
