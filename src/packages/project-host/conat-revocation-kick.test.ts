/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const stats = jest.fn();
const disconnect = jest.fn(async (_ids: string[]) => {});
jest.mock("@cocalc/conat/core/sys", () => ({
  sysApi: () => ({ stats: () => stats(), disconnect: (ids) => disconnect(ids) }),
}));
const revoked = jest.fn();
jest.mock("./conat-auth", () => ({
  isAccountSessionRevoked: (opts: any) => revoked(opts),
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), debug: jest.fn() }),
}));

import { startConatRevocationKickLoop } from "./conat-revocation-kick";

const BROWSER = "00000000-0000-4000-8000-000000000001";

it("disconnects revoked sockets, telling the check which are an agent's", async () => {
  stats.mockResolvedValue({
    server1: {
      s1: { user: { account_id: BROWSER, auth_iat_s: 100 } },
      s2: { user: { account_id: BROWSER, auth_iat_s: 100, auth_actor: "agent" } },
      s3: { user: { hub_id: "hub" } },
    },
  });
  // A password change: browsers are revoked, an agent's credential isn't.
  revoked.mockImplementation((opts) => opts.auth_actor !== "agent");
  const stop = startConatRevocationKickLoop({
    client: { isSignedIn: () => true } as any,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop();
  expect(revoked).toHaveBeenCalledWith({
    account_id: BROWSER,
    issued_at_s: 100,
    auth_actor: "agent",
  });
  expect(disconnect).toHaveBeenCalledWith(["s1"]);
});
