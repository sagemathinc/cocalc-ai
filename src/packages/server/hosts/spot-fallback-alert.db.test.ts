/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The alert's query against real PostgreSQL: which hosts it reads.

const mockConditionAlert = jest.fn();
const mockConditionCleared = jest.fn();

jest.mock("./condition-alert", () => ({
  ...jest.requireActual("./condition-alert"),
  conditionAlert: (...args: any[]) => mockConditionAlert(...args),
  conditionCleared: (...args: any[]) => mockConditionCleared(...args),
}));

import { after, before, getPool } from "@cocalc/server/test";
import { runSpotFallbackAlertCheck } from "./spot-fallback-alert";

const ids = {
  alternate: "5f000000-0000-4000-8000-000000000001",
  legacyPricing: "5f000000-0000-4000-8000-000000000002",
  onDemand: "5f000000-0000-4000-8000-000000000003",
  deleted: "5f000000-0000-4000-8000-000000000004",
  stopped: "5f000000-0000-4000-8000-000000000005",
};

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);

afterAll(after);

describe("runSpotFallbackAlertCheck query", () => {
  beforeAll(async () => {
    await getPool().query(`CREATE TABLE IF NOT EXISTS project_hosts (
      id UUID PRIMARY KEY, name TEXT, bay_id TEXT, status TEXT,
      last_seen TIMESTAMP, deleted TIMESTAMP, metadata JSONB,
      public_url TEXT, internal_url TEXT
    )`);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const metadata = (pricing: Record<string, any>) => ({
      ...pricing,
      machine: { machine_type: "t2d-standard-16" },
      spot_recovery_state: {
        phase: "idle",
        active_machine_type: "n2d-custom-32-65536",
        machine_type_attempt_started_at: since,
      },
    });
    const insert = (
      id: string,
      name: string,
      status: string,
      pricing: Record<string, any>,
      deleted = false,
    ) =>
      getPool().query(
        `INSERT INTO project_hosts (id, name, status, metadata, deleted)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, status, metadata(pricing), deleted ? new Date() : null],
      );
    await insert(ids.alternate, "alt host", "running", {
      desired_pricing_model: "spot",
    });
    // Older hosts only have pricing_model, possibly not normalized.
    await insert(ids.legacyPricing, "legacy host", "running", {
      pricing_model: " SPOT ",
    });
    await insert(ids.onDemand, "standard host", "running", {
      desired_pricing_model: "on_demand",
      pricing_model: "spot",
    });
    await insert(
      ids.deleted,
      "deleted host",
      "running",
      { desired_pricing_model: "spot" },
      true,
    );
    await insert(ids.stopped, "stopped host", "off", {
      desired_pricing_model: "spot",
    });
  });

  afterAll(async () => {
    await getPool().query(
      "DELETE FROM project_hosts WHERE id=ANY($1::uuid[])",
      [Object.values(ids)],
    );
  });

  it("reads running, undeleted Spot hosts only, as desiredPricingModel does", async () => {
    await expect(runSpotFallbackAlertCheck()).resolves.toBe(2);
    const [{ body }] = mockConditionAlert.mock.calls[0];
    expect(body).toContain("- `alt host`");
    expect(body).toContain("- `legacy host`");
    for (const name of ["standard host", "deleted host", "stopped host"]) {
      expect(body).not.toContain(name);
    }
  });
});
