/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import {
  getGpuBudgetLocal,
  planBudgetChange,
  setGpuBudget,
  setGpuBudgetLocal,
} from "./budget-api";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const LAYER = {
  authorized_usd: "20",
  max_hourly_usd: "5",
  max_concurrent_pods: 2,
  max_gpu_count: 4,
  max_runtime_minutes: 480,
  starts_at: new Date("2026-10-01T00:00:00Z"),
  ends_at: new Date("2027-10-01T00:00:00Z"),
};

describe("planBudgetChange", () => {
  it("tells lowering from raising", () => {
    expect(
      planBudgetChange(LAYER, {
        authorized_usd: 10,
        max_concurrent_pods: 1,
        max_runtime_minutes: 60,
        ends_at: "2027-01-01T00:00:00Z",
      }).raises,
    ).toEqual([]);
    expect(
      planBudgetChange(LAYER, {
        authorized_usd: "25",
        max_hourly_usd: null,
        max_gpu_count: 8,
        ends_at: "2028-01-01T00:00:00Z",
      }).raises,
    ).toEqual(["authorized_usd", "max_hourly_usd", "max_gpu_count", "ends_at"]);
    // adding a limit where there was none narrows
    expect(
      planBudgetChange(
        { ...LAYER, max_hourly_usd: null },
        { max_hourly_usd: 3 },
      ).raises,
    ).toEqual([]);
  });

  it.each([
    [{ authorized_usd: 0 }, "more than 0"],
    [{ authorized_usd: "abc" }, "must be a number"],
    [{ authorized_usd: 1e9 }, "at most"],
    [{ authorized_usd: null }, "required"],
    [{ max_concurrent_pods: 1.5 }, "whole number"],
    [{ max_gpu_count: -1 }, "whole number"],
    [{ ends_at: "2026-01-01T00:00:00Z" }, "after the budget starts"],
    [{}, "Nothing to change"],
  ])("rejects %j", (change, message) => {
    expect(() => planBudgetChange(LAYER, change as any)).toThrow(message);
  });
});

describeDb("gpu.budget and gpu.setBudget", () => {
  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await syncSchema({
      gpu_key_fences: SCHEMA.gpu_key_fences,
      gpu_budget_layers: SCHEMA.gpu_budget_layers,
      gpu_budget_events: SCHEMA.gpu_budget_events,
      gpu_pods: SCHEMA.gpu_pods,
      gpu_pod_reservations: SCHEMA.gpu_pod_reservations,
      gpu_worker_leases: SCHEMA.gpu_worker_leases,
      gpu_worker_overrides: SCHEMA.gpu_worker_overrides,
    });
    // the reaper has just completed a sweep (admission requires it)
    await getPool().query(
      "INSERT INTO gpu_worker_leases (name, last_completed_at) VALUES ('reaper', now() + interval '10 years') ON CONFLICT (name) DO UPDATE SET last_completed_at = EXCLUDED.last_completed_at",
    );
  });

  function setup() {
    const account_id = randomUUID();
    const credential_id = randomUUID();
    const deps = {
      credentialId: async () => credential_id,
      accountFence: async (opts: any) => {
        await getPool().query(
          "INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [opts.account_id],
        );
        return await withAccountRehomeWriteFence(opts);
      },
    };
    return { account_id, credential_id, deps };
  }

  it("shows the default budget of a new key, with its create event", async () => {
    const { account_id, deps } = setup();
    const b = await getGpuBudgetLocal({ account_id }, deps);
    expect(b).toEqual(
      expect.objectContaining({
        version: 1,
        authorized_usd: "20.0000000000",
        available_usd: "20.0000000000",
        max_concurrent_pods: 2,
        live_pods: 0,
      }),
    );
    const { rows } = await getPool().query(
      "SELECT action FROM gpu_budget_events WHERE layer_id = $1",
      [b.layer_id],
    );
    expect(rows.map((r) => r.action)).toEqual(["create"]);
  });

  it("lowers without fresh auth, refuses a raise without it, and records both changes", async () => {
    const { account_id, deps } = setup();
    const lowered = await setGpuBudgetLocal(
      { account_id, change: { authorized_usd: 10, max_concurrent_pods: 1 } },
      deps,
    );
    expect(lowered.authorized_usd).toBe("10.0000000000");
    expect(lowered.version).toBe(2);
    await expect(
      setGpuBudgetLocal({ account_id, change: { authorized_usd: 50 } }, deps),
    ).rejects.toThrow("needs you to sign in again");
    const raised = await setGpuBudgetLocal(
      {
        account_id,
        change: { authorized_usd: 50 },
        fresh_auth_verified: true,
      },
      deps,
    );
    expect(raised.authorized_usd).toBe("50.0000000000");
    const { rows } = await getPool().query(
      "SELECT action, before, after FROM gpu_budget_events WHERE layer_id = $1 ORDER BY at",
      [raised.layer_id],
    );
    expect(rows.map((r) => r.action)).toEqual(["create", "update", "update"]);
    expect(rows[2].after).toEqual({ authorized_usd: "50.0000000000" });
  });

  it("refuses a change based on a stale version", async () => {
    const { account_id, deps } = setup();
    const b = await getGpuBudgetLocal({ account_id }, deps);
    await setGpuBudgetLocal(
      { account_id, change: { max_gpu_count: 2 }, expected_version: b.version },
      deps,
    );
    await expect(
      setGpuBudgetLocal(
        {
          account_id,
          change: { max_gpu_count: 1 },
          expected_version: b.version,
        },
        deps,
      ),
    ).rejects.toThrow("changed since you loaded it");
  });

  it("shows an overrun as over budget, never a negative available", async () => {
    const { account_id, credential_id, deps } = setup();
    await getGpuBudgetLocal({ account_id }, deps);
    await getPool().query(
      "UPDATE gpu_budget_layers SET spent_usd = 23.5 WHERE credential_id = $1",
      [credential_id],
    );
    const b = await getGpuBudgetLocal({ account_id }, deps);
    expect(b.available_usd).toBe("0.0000000000");
    expect(b.over_budget_usd).toBe("3.5000000000");
  });

  it("says when no key is connected", async () => {
    const { account_id } = setup();
    await expect(
      getGpuBudgetLocal(
        { account_id },
        { credentialId: async () => undefined },
      ),
    ).rejects.toThrow("No RunPod API key is connected");
  });
});

describe("setGpuBudget on the signed-in bay", () => {
  const account_id = "00000000-1000-4000-8000-000000000001";

  it("checks fresh auth when a browser offers it, and forwards only what it verified", async () => {
    const freshAuth = jest.fn(async () => ({}) as any);
    const remote = { gpuSetBudget: jest.fn(async () => ({}) as any) };
    await setGpuBudget(
      {
        account_id,
        browser_id: "browser-1",
        change: { authorized_usd: 50 },
        // anything else a caller adds stays behind
        fresh_auth_verified: true,
      } as any,
      { freshAuth, homeClient: async () => remote as any },
    );
    expect(freshAuth).toHaveBeenCalledWith(
      expect.objectContaining({ account_id, browser_id: "browser-1" }),
    );
    expect(remote.gpuSetBudget).toHaveBeenCalledWith({
      account_id,
      change: { authorized_usd: 50 },
      expected_version: undefined,
      fresh_auth_verified: true,
    });
  });

  it("never claims fresh auth it didn't check", async () => {
    const freshAuth = jest.fn();
    const remote = { gpuSetBudget: jest.fn(async () => ({}) as any) };
    await setGpuBudget(
      {
        account_id,
        change: { authorized_usd: 5 },
        fresh_auth_verified: true,
      } as any,
      { freshAuth, homeClient: async () => remote as any },
    );
    expect(freshAuth).not.toHaveBeenCalled();
    expect(remote.gpuSetBudget).toHaveBeenCalledWith(
      expect.objectContaining({ fresh_auth_verified: false }),
    );
  });

  it("fails when the offered fresh auth doesn't check out", async () => {
    const freshAuth = jest.fn(async () => {
      throw Error("fresh authentication required");
    });
    const remote = { gpuSetBudget: jest.fn() };
    await expect(
      setGpuBudget(
        { account_id, browser_id: "b", change: { authorized_usd: 50 } },
        { freshAuth, homeClient: async () => remote as any },
      ),
    ).rejects.toThrow("fresh authentication required");
    expect(remote.gpuSetBudget).not.toHaveBeenCalled();
  });
});
