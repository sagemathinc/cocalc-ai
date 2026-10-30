/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The funder's routed entry points (PROJECT_FUNDING.md §6): fresh
// authentication is checked on the signed-in bay and forwarded as a fact to
// the funder's home bay; an approval always needs it.

import {
  approveProjectFunding,
  changeProjectFunding,
  fundedProjects,
  revokeProjectFunding,
} from "./project-funding-api";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";

function home() {
  const calls: Record<string, any[]> = {};
  const record = (name: string) => async (opts: any) => {
    (calls[name] ??= []).push(opts);
    return { ok: name } as any;
  };
  return {
    calls,
    client: {
      gpuApproveProjectFunding: record("approve"),
      gpuChangeProjectFunding: record("change"),
      gpuRevokeProjectFunding: record("revoke"),
      gpuFundedProjects: record("funded"),
    } as any,
  };
}

describe("project funding hub entry points", () => {
  it("refuses an approval without a fresh sign-in, and forwards one with it", async () => {
    const h = home();
    const deps = {
      homeClient: async () => h.client,
      freshAuth: jest.fn(async () => {
        throw Error("not fresh");
      }),
    };
    await expect(
      approveProjectFunding(
        {
          account_id: ACCOUNT,
          browser_id: "b",
          project_id: "p",
          terms: {},
          operation_id: "o",
        },
        deps as any,
      ),
    ).rejects.toThrow(/sign in again/);
    // no session given at all: refused too
    await expect(
      approveProjectFunding({ account_id: ACCOUNT }, deps as any),
    ).rejects.toThrow(/sign in again/);
    expect(h.calls.approve).toBeUndefined();
    deps.freshAuth = jest.fn(async () => undefined) as any;
    await approveProjectFunding(
      {
        account_id: ACCOUNT,
        browser_id: "b",
        project_id: "p",
        terms: { a: 1 },
        operation_id: "o",
        raise_key_budget_to: "400",
      },
      deps as any,
    );
    expect(h.calls.approve).toEqual([
      {
        account_id: ACCOUNT,
        project_id: "p",
        terms: { a: 1 },
        operation_id: "o",
        raise_key_budget_to: "400",
        fresh_auth_verified: true,
      },
    ]);
  });

  it("forwards a change with whether the sign-in was fresh (the funder's bay decides)", async () => {
    const h = home();
    await changeProjectFunding(
      {
        account_id: ACCOUNT,
        approval_id: "a",
        change: { authorized_usd: "1" },
      },
      { homeClient: async () => h.client } as any,
    );
    await changeProjectFunding(
      {
        account_id: ACCOUNT,
        session_hash: "s",
        approval_id: "a",
        change: { authorized_usd: "9" },
      },
      {
        homeClient: async () => h.client,
        freshAuth: async () => undefined,
      } as any,
    );
    expect(h.calls.change.map((c) => c.fresh_auth_verified)).toEqual([
      false,
      true,
    ]);
    await changeProjectFunding(
      {
        account_id: ACCOUNT,
        approval_id: "a",
        change: { authorized_usd: "1" },
        narrow_only: true,
      },
      { homeClient: async () => h.client } as any,
    );
    expect(h.calls.change.map((c) => c.narrow_only)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("forwards revoke and the list to the funder's home, as themselves", async () => {
    const h = home();
    const deps = { homeClient: async () => h.client } as any;
    await revokeProjectFunding({ account_id: ACCOUNT, approval_id: "a" }, deps);
    await fundedProjects({ account_id: ACCOUNT }, deps);
    expect(h.calls.revoke).toEqual([{ account_id: ACCOUNT, approval_id: "a" }]);
    expect(h.calls.funded).toEqual([{ account_id: ACCOUNT }]);
    await expect(fundedProjects({ account_id: "nope" }, deps)).rejects.toThrow(
      /signed in/,
    );
  });
});
