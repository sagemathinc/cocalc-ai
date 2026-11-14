/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getHubApiPrincipalPolicies, transformArgs } from "./index";

const account_id = "00000000-0000-4000-8000-000000000001";

describe("a caller can never supply trusted_* options", () => {
  const methods = Object.keys(getHubApiPrincipalPolicies());

  const callers: [string, Record<string, unknown>][] = [
    ["an account", { account_id, auth_session_hash: null }],
    ["a project", { project_id: "00000000-0000-4000-8000-000000000002" }],
    ["a host", { host_id: "00000000-0000-4000-8000-0000000000dd" }],
  ];
  for (const [who, context] of callers) {
    it(`strips them from ${who} caller on every method`, async () => {
      expect(methods.length).toBeGreaterThan(100);
      for (const name of methods) {
        const args = [
          { trusted_admin_view: true, trusted_admin: true, id: "x" },
          { trusted_anything: 1 },
        ];
        let result: any[] | undefined;
        try {
          result = await transformArgs({ name, args, ...context } as any);
        } catch {
          // refused outright is fine too
        }
        for (const arg of [...args, ...(result ?? [])]) {
          if (arg == null || typeof arg !== "object") continue;
          expect(
            Object.keys(arg).filter((key) => key.startsWith("trusted_")),
          ).toEqual([]);
        }
      }
    });
  }

  it("keeps the caller's other options", async () => {
    const args = [{ trusted_admin_view: true, admin_view: true, id: "h1" }];
    await transformArgs({
      name: "hosts.listHosts",
      args,
      account_id,
      auth_session_hash: null,
    } as any).catch(() => undefined);
    expect(args[0]).toEqual(
      expect.objectContaining({ admin_view: true, id: "h1", account_id }),
    );
    expect(args[0]).not.toHaveProperty("trusted_admin_view");
  });
});
