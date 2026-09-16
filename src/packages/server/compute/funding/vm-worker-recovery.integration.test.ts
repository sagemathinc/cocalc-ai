/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getComputeVmById } from "../db";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { reserveComputeVmFundingLocal } from "./vm-reservations";
import {
  recoverExistingCourseVmFunding,
  recoverTerminalCourseVmFunding,
} from "./vm-worker-recovery";
import { meterCourseVm } from "./vm-funding";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";

jest.mock("@cocalc/server/bay-config", () => {
  const bay = `recovery-test-${require("node:crypto").randomUUID()}`;
  return {
    ...jest.requireActual("@cocalc/server/bay-config"),
    getConfiguredBayId: () => bay,
    getConfiguredClusterBayCatalog: () => [{ bay_id: bay }],
  };
});

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));
// Settlement math belongs to the separate lifecycle tests. This test exercises
// real lookup, account locks, metadata CAS, and durable terminal rediscovery.
jest.mock("./vm-funding", () => ({
  ...jest.requireActual("./vm-funding"),
  meterCourseVm: jest.fn(),
}));

const resources = fundingResourceFixtures();
beforeAll(async () => before({ noConat: true }), 60_000);
afterAll(async () => {
  try {
    await resources.cleanup();
  } finally {
    await after();
  }
});

it("recovers an existing reservation after deletion and preserves its full commitment until settlement succeeds", async () => {
  const payer = randomUUID(),
    owner = randomUUID(),
    id = randomUUID(),
    epoch = randomUUID();
  resources.add(payer, owner);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1),($2)", [
    payer,
    owner,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-10,'credit',NOW())",
    [payer],
  );
  const allocation = await withFundingAccountTransaction(payer, (db) =>
    createCourseFundingPoolInTransaction(db, {
      payer_account_id: payer,
      operation_id: randomUUID(),
      terms: {
        course_project_id: randomUUID(),
        course_instance_id: randomUUID(),
        currency: "USD",
        lane: "prepaid",
        amount_usd: "5",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        recipients: [{ beneficiary_account_id: owner, amount_usd: "5" }],
      },
    }),
  );
  const source = {
    kind: "course" as const,
    payer_account_id: payer,
    pool_id: allocation.pool.id,
    grant_id: allocation.grants[0].id,
  };
  await getPool().query(
    `INSERT INTO compute_vms
    (id,owner_account_id,owning_bay_id,name,public_hostname,bootstrap_revision,funding_mode,state,desired_state,provider,instance_generation,metadata,deleted_at)
    VALUES ($1,$2,$3,'recovery-test',$1::uuid::text || '.example',2,'account-prepaid','deleted','deleted','nebius',1,$4,NOW())`,
    [
      id,
      owner,
      getConfiguredBayId(),
      { billing: { course_funding: { source, funding_epoch: epoch } } },
    ],
  );
  const vm = (await getComputeVmById(id))!;
  await recoverTerminalCourseVmFunding();
  expect(meterCourseVm).not.toHaveBeenCalled();
  expect(
    (await getComputeVmById(id))!.metadata.billing.course_funding.binding,
  ).toBeUndefined();
  // The original in-flight reservation completes after cancellation. Recovery
  // must still find it even though a prior pass found nothing to attach.
  const binding = await reserveComputeVmFundingLocal({
    account_id: payer,
    source,
    resource_id: id,
    resource_generation: 1,
    owner_account_id: owner,
    owning_bay_id: getConfiguredBayId(),
    funding_epoch: epoch,
    provider: "nebius",
    hourly_cost_usd: "1",
    storage_hourly_cost_usd: "0.01",
    pricing_snapshot: {},
    requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
  });
  const recovered = (await recoverExistingCourseVmFunding(vm))!;
  expect(recovered.metadata.billing.course_funding.binding).toEqual(binding);
  expect(recovered.desired_state).toBe("deleted");
  expect(recovered.deleted_at).toEqual(vm.deleted_at);
  // Replay of the stale unbound snapshot cannot overwrite a recovered binding.
  expect(await recoverExistingCourseVmFunding(vm)).toBeUndefined();
  const snapshot = async () =>
    (
      await getPool().query(
        "SELECT state,authorized_usd,spent_usd,released_usd FROM compute_funding_reservations WHERE resource_id=$1",
        [id],
      )
    ).rows;
  const beforeRetry = await snapshot();
  expect(beforeRetry).toHaveLength(1);
  expect(Number(beforeRetry[0].released_usd)).toBe(0);
  jest
    .mocked(meterCourseVm)
    .mockRejectedValueOnce(new Error("payer unavailable"));
  await recoverTerminalCourseVmFunding();
  await recoverTerminalCourseVmFunding();
  expect(meterCourseVm).toHaveBeenCalledTimes(2);
  expect(meterCourseVm).toHaveBeenLastCalledWith(
    expect.objectContaining({ id, desired_state: "deleted" }),
    true,
  );
  expect(await snapshot()).toEqual(beforeRetry);
  const {
    rows: [pool],
  } = await getPool().query(
    "SELECT reserved_usd FROM compute_funding_pools WHERE id=$1",
    [source.pool_id],
  );
  expect(pool.reserved_usd).toBe(binding.authorized_usd);
});
