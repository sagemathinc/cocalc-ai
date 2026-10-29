/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Fresh-auth and similar checks trust opts.session_hash. Every Hub API method
// an account can call must bind it to the caller's own session (or refuse the
// request): a session must never borrow another session's freshness by
// naming it.

import { getHubApiPrincipalPolicies, transformArgs } from "./index";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const FORGED = "forged-session-hash";
const OWN = "own-session-hash";

// Reviewed custom transforms that bind the account but no session; their
// implementations never run a fresh-auth check with the request's browser_id
// as a session fallback.
// startCodexFreshAuthAction looks up the browser by browser_id only to start
// a challenge the person must approve in that browser; it never treats that
// session as already fresh.
const NO_FRESH_AUTH_FALLBACK = new Set<string>([
  "notifications.createCodexAttentionNotice",
  "notifications.createCodexTurnNotice",
  "notifications.getCodexFreshAuthActionStatus",
  "notifications.startCodexFreshAuthAction",
]);

// Account methods a project host's embedded Lite hub serves
// (project-host/hub/api-request-authorization.ts). Lite passes the request
// body's auth_session_hash, usually absent: browsers never send their home
// session to a project host.
const PROJECT_HOST_ACCOUNT_METHODS = [
  "projects.codexDeviceAuthStart",
  "projects.codexDeviceAuthStartV2",
  "projects.getCodexCredentialSelectionCapability",
  "projects.codexDeviceAuthStatus",
  "projects.codexDeviceAuthCancel",
  "projects.claudeSubscriptionLoginStart",
  "projects.claudeSubscriptionLoginStatus",
  "projects.claudeSubscriptionLoginSubmitCode",
  "projects.claudeSubscriptionLoginCancel",
  "projects.codexUploadAuthFile",
  "projects.codexUploadAuthFileV2",
  "projects.getCodexUsageStatus",
  "projects.chatStoreStats",
  "projects.chatStoreRotate",
  "projects.chatStoreListSegments",
  "projects.chatStoreReadArchived",
  "projects.chatStoreReadArchivedHit",
  "projects.chatStoreSearch",
  "projects.chatStoreDelete",
  "projects.chatStoreVacuum",
  "notifications.createCodexAttentionNotice",
  "notifications.getCodexFreshAuthActionStatus",
];

function accountMethods(): string[] {
  return Object.entries(getHubApiPrincipalPolicies())
    .filter(
      ([, policy]) => policy.includes("account") || policy == "authenticated",
    )
    .map(([name]) => name)
    .sort();
}

function sessionHashes(args: unknown): unknown[] {
  if (!Array.isArray(args)) return [];
  return args
    .filter((arg) => arg != null && typeof arg === "object")
    .map((arg) => (arg as any).session_hash);
}

async function transformed(
  name: string,
  auth_session_hash: string | null,
): Promise<unknown[] | "refused"> {
  try {
    return sessionHashes(
      await transformArgs({
        name,
        args: [{ session_hash: FORGED, project_id: PROJECT }],
        account_id: ACCOUNT,
        auth_session_hash,
      }),
    );
  } catch {
    return "refused";
  }
}

describe("Hub API session binding", () => {
  const methods = accountMethods();

  it("covers the account methods", () => {
    expect(methods.length).toBeGreaterThan(100);
  });

  it.each(methods)(
    "%s never passes a session the caller named",
    async (name) => {
      for (const own of [OWN, null]) {
        const result = await transformed(name, own);
        if (result !== "refused") {
          expect(result).not.toContain(FORGED);
        }
      }
    },
  );

  // Fresh-auth checks fall back to a browser named by browser_id only when
  // session_hash is undefined (an internal call). A caller without a session
  // of its own must get null, or the method must not act as that account.
  it.each(methods)(
    "%s gives a caller without a session no browser fallback",
    async (name) => {
      let args;
      try {
        args = await transformArgs({
          name,
          args: [{ project_id: PROJECT, browser_id: "fresh-browser" }],
          account_id: ACCOUNT,
          auth_session_hash: null,
        });
      } catch {
        return;
      }
      for (const arg of Array.isArray(args) ? args : []) {
        if (arg == null || typeof arg !== "object") continue;
        if ((arg as any).account_id !== ACCOUNT) continue;
        if (NO_FRESH_AUTH_FALLBACK.has(name)) continue;
        expect((arg as any).session_hash).toBeNull();
      }
    },
  );

  it.each(methods)("%s binds the caller's own session", async (name) => {
    let args;
    try {
      args = await transformArgs({
        name,
        args: [{ project_id: PROJECT }],
        account_id: ACCOUNT,
        auth_session_hash: OWN,
      });
    } catch {
      return; // needs other arguments, or is not for plain accounts
    }
    for (const hash of sessionHashes(args)) {
      expect([OWN, undefined]).toContain(hash);
    }
  });

  it.each(PROJECT_HOST_ACCOUNT_METHODS)(
    "%s still accepts a normal project-host (Lite) request",
    async (name) => {
      for (const auth_session_hash of [undefined, "home-session"]) {
        await expect(
          transformArgs({
            name,
            args: [{ project_id: PROJECT }],
            account_id: ACCOUNT,
            auth_session_hash,
          }),
        ).resolves.toBeDefined();
      }
    },
  );

  it("keeps null for bound-session methods, so no browser fallback", async () => {
    // A caller without a session (an API key, or an old router that does
    // not stamp) must not borrow a browser session it names.
    for (const name of [
      "projects.transferProjectOwnership",
      "hosts.issueProjectContentUrl",
      "personalUrls.releaseRedirect",
    ]) {
      const [opts] = await transformArgs({
        name,
        args: [{ project_id: PROJECT, browser_id: "fresh-browser" }],
        account_id: ACCOUNT,
        auth_session_hash: null,
      });
      expect(opts.session_hash).toBeNull();
    }
  });
});
