import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { audit, auditFundingSnapshot } from "./reconciliation";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "./vm-reservations";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
const resources = fundingResourceFixtures();
beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(async () => {
  try {
    await resources.cleanup();
  } finally {
    await after();
  }
});
beforeEach(() => {
  jest.mocked(resolveAccountHomeBay).mockResolvedValue({
    home_bay_id: getConfiguredBayId(),
  } as any);
});

async function fixture() {
  const payer = randomUUID();
  resources.add(payer);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-10,'credit',now())",
    [payer],
  );
  const result = await withFundingAccountTransaction(payer, (db) =>
    createCourseFundingPoolInTransaction(db, {
      payer_account_id: payer,
      operation_id: randomUUID(),
      terms: {
        course_project_id: randomUUID(),
        course_instance_id: randomUUID(),
        currency: "USD",
        lane: "prepaid",
        amount_usd: "10",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400000).toISOString(),
        recipients: [
          { beneficiary_account_id: randomUUID(), amount_usd: "10" },
        ],
      },
    }),
  );
  return { payer, pool: result.pool, grant: result.grants[0] };
}

it("reconciles actual reservation and purchase settlement with the course totals", async () => {
  const { payer, pool, grant } = await fixture();
  const binding = await reserveComputeVmFundingLocal({
    account_id: payer,
    source: {
      kind: "course",
      payer_account_id: payer,
      pool_id: pool.id,
      grant_id: grant.id,
    },
    resource_id: randomUUID(),
    resource_generation: 1,
    funding_epoch: randomUUID(),
    owner_account_id: grant.beneficiary_account_id,
    owning_bay_id: getConfiguredBayId(),
    provider: "nebius",
    hourly_cost_usd: "1",
    storage_hourly_cost_usd: "0.001",
    pricing_snapshot: { provider: "nebius" },
    requested_until: new Date(Date.now() + 25 * 60000).toISOString(),
  });
  await checkComputeVmFundingLocal({
    account_id: payer,
    binding,
    dispatch: true,
  });
  const runningStart = new Date(Date.now() - 60000).toISOString();
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=$2 WHERE id=$1",
    [binding.reservation_id, runningStart],
  );
  await settleComputeVmFundingLocal({
    account_id: payer,
    binding,
    running_started_at: runningStart,
    running_until: new Date().toISOString(),
  });
  const db = await getPool().connect();
  try {
    const report = await auditFundingSnapshot(db, payer, getConfiguredBayId());
    expect(report.findings).toEqual([]);
    expect(report.reservations).toHaveLength(1);
    expect(Number(report.reservations[0].spent_usd)).toBeGreaterThan(0);
  } finally {
    db.release();
  }
});

it("reports clean allocation and identifies a backing mismatch without repairing it", async () => {
  const { payer, pool } = await fixture();
  const db = await getPool().connect();
  try {
    const clean = await auditFundingSnapshot(db, payer, getConfiguredBayId());
    expect(clean.findings).toEqual([]);
    expect(clean.backing).toEqual([
      { lane: "prepaid", held_usd: "10.0000000000" },
    ]);
    await db.query(
      "UPDATE account_funding_holds SET remaining_usd=9 WHERE source_id=$1",
      [pool.id],
    );
    const report = await auditFundingSnapshot(db, payer, getConfiguredBayId());
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "pool_backing_mismatch",
        resource_id: pool.id,
      }),
    ]);
    const { rows } = await db.query(
      "SELECT remaining_usd::text FROM account_funding_holds WHERE source_id=$1",
      [pool.id],
    );
    expect(rows[0].remaining_usd).toBe("9.0000000000");
  } finally {
    db.release();
  }
});

it("requires administrator authentication, explicit bay, and current payer ownership", async () => {
  const opts = {
    account_id: randomUUID(),
    payer_account_id: randomUUID(),
    bay_id: getConfiguredBayId(),
  };
  jest.mocked(isAdmin).mockResolvedValue(false);
  await expect(audit(opts)).rejects.toThrow("Administrator access required");
  jest.mocked(isAdmin).mockResolvedValue(true);
  await expect(audit({ ...opts, bay_id: "wrong-bay" })).rejects.toThrow(
    "explicitly selected",
  );
  jest
    .mocked(resolveAccountHomeBay)
    .mockResolvedValue({ home_bay_id: "another-bay" } as any);
  await expect(audit(opts)).rejects.toThrow(
    "not the payer's authoritative home",
  );
});

it("refuses to report frozen authority as an authoritative healthy snapshot", async () => {
  const { payer } = await fixture();
  await getPool().query(
    "UPDATE account_funding_authorities SET state='frozen' WHERE payer_account_id=$1",
    [payer],
  );
  const db = await getPool().connect();
  try {
    await expect(
      auditFundingSnapshot(db, payer, getConfiguredBayId()),
    ).rejects.toThrow("moving or inactive");
  } finally {
    db.release();
  }
});
