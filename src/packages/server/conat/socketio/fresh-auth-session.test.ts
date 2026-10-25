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

  it("a transferProjectOwnership request bound to no session gets no fallback", async () => {
    const { transformArgs } = await import("@cocalc/conat/hub/api");
    const [opts] = await transformArgs({
      name: "projects.transferProjectOwnership",
      args: [{ project_id: "p", browser_id: "fresh-browser" }],
      account_id,
      auth_session_hash: null,
    });
    expect(
      resolveFreshAuthSessionHash({
        account_id,
        browser_id: opts.browser_id,
        session_hash: opts.session_hash,
      }),
    ).toBeUndefined();
  });
});
