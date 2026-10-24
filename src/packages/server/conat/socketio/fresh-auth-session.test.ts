/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { recordBrowserAuthSession } from "./browser-auth-sessions";
import { resolveFreshAuthSessionHash } from "./fresh-auth-session";

const account_id = "00000000-0000-4000-8000-000000000001";

describe("resolveFreshAuthSessionHash", () => {
  beforeAll(() => {
    recordBrowserAuthSession({
      account_id,
      browser_id: "fresh-browser",
      session_hash: "browser-session",
    });
  });

  it("uses the given session", () => {
    expect(
      resolveFreshAuthSessionHash({
        account_id,
        browser_id: "fresh-browser",
        session_hash: "own",
      }),
    ).toBe("own");
  });

  it("falls back to the named browser only for internal calls", () => {
    expect(
      resolveFreshAuthSessionHash({ account_id, browser_id: "fresh-browser" }),
    ).toBe("browser-session");
  });

  it("never lets a request bound to no session borrow a browser's", () => {
    expect(
      resolveFreshAuthSessionHash({
        account_id,
        browser_id: "fresh-browser",
        session_hash: null,
      }),
    ).toBeUndefined();
  });
});
