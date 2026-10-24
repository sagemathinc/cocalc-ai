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
});
