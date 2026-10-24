/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { boundHubApiSessionHash } from "./bound-session";

const account_id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

describe("boundHubApiSessionHash", () => {
  it("uses the session stamped from the caller's connection", () => {
    expect(
      boundHubApiSessionHash({
        account_id,
        caller: { account_id, auth_session_hash: "own" },
      }),
    ).toBe("own");
    expect(
      boundHubApiSessionHash({
        account_id,
        caller: { account_id, auth_session_hash: "own" },
        requested: "own",
      }),
    ).toBe("own");
  });

  it("refuses a request that names another session", () => {
    expect(() =>
      boundHubApiSessionHash({
        account_id,
        caller: { account_id, auth_session_hash: "own" },
        requested: "other",
      }),
    ).toThrow(/other than the caller's own/);
    // No session of its own (an API key): it may not name one either.
    expect(() =>
      boundHubApiSessionHash({
        account_id,
        caller: { account_id, auth_session_hash: null },
        requested: "other",
      }),
    ).toThrow(/other than the caller's own/);
  });

  it("never trusts the request without a stamped session", () => {
    for (const caller of [
      undefined,
      { hub_id: "x" } as any,
      { account_id: other, auth_session_hash: "theirs" },
    ]) {
      expect(boundHubApiSessionHash({ account_id, caller })).toBeNull();
      expect(() =>
        boundHubApiSessionHash({ account_id, caller, requested: "named" }),
      ).toThrow();
    }
  });

  it("has no session for non-account principals", () => {
    expect(
      boundHubApiSessionHash({
        caller: { account_id, auth_session_hash: "own" },
        requested: "own",
      }),
    ).toBeNull();
  });
});
