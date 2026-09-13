/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getComputeVmById, updateComputeInstance } from "../db";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "./vm-reservations";
import {
  meterCourseVm,
  courseVmBinding,
  enqueueCourseFundingDeadlines,
  payerApi,
} from "./vm-funding";
import { getComputeVmFallbackDecisionLocal } from "./vm-fallback-reason";
import {
  previewVmPersonalFunding,
  getVmPersonalFunding,
  clearVmPersonalFunding,
  switchVmPersonalFunding,
  processVmPersonalFundingHandoffs,
} from "./vm-personal";
import { setPolicy } from "./__tests__/policy-source";
import { prepareCourseVmRestart } from "./vm-restart";
import { requestScheduledVmState } from "../scheduled-stop";
import type { VmPersonalFundingTerms } from "@cocalc/util/compute-vm-funding";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";
import * as exposure from "./exposure";
import { settleComputeVmFundingLocal } from "./vm-settlement";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("./approvals", () => ({
  assertFundingPayerHomeBay: async () => {},
  proposeVmPersonalFundingApproval: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));

beforeAll(async () => before({ noConat: true }), 60_000);
const fixtures = fundingResourceFixtures();
afterEach(async () => {
  jest.restoreAllMocks();
  await fixtures.cleanup();
});
afterAll(async () => {
  try {
    await fixtures.cleanup();
  } finally {
    await after();
  }
});

async function fixture(provider: "nebius" | "gcp" = "nebius") {
  const payer = randomUUID(),
    student = randomUUID(),
    vmId = randomUUID(),
    epoch = randomUUID(),
    consentId = randomUUID();
  fixtures.add(payer, student);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1),($2)", [
    payer,
    student,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',NOW()),($2,-10,'credit',NOW())",
    [payer, student],
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
        amount_usd: "50",
        allow_overcommit: false,
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        recipients: [{ beneficiary_account_id: student, amount_usd: "50" }],
      },
    }),
  );
  const source = {
    kind: "course" as const,
    pool_id: allocation.pool.id,
    grant_id: allocation.grants[0].id,
    payer_account_id: payer,
  };
  const binding = await reserveComputeVmFundingLocal({
    account_id: payer,
    source,
    resource_id: vmId,
    resource_generation: 1,
    funding_epoch: epoch,
    owner_account_id: student,
    owning_bay_id: getConfiguredBayId(),
    provider,
    hourly_cost_usd: "6",
    storage_hourly_cost_usd: "0.01",
    pricing_snapshot: { provider },
    requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
  });
  await checkComputeVmFundingLocal({
    account_id: payer,
    binding,
    dispatch: true,
  });
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=NOW()-interval '1 minute' WHERE id=$1",
    [binding.reservation_id],
  );
  const rate = { hourly_cost_usd: "6", pricing_snapshot: { provider } };
  await getPool().query(
    `INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,name,public_hostname,bootstrap_revision,funding_mode,state,desired_state,stop_generation,boot_disk_id,provider,instance_generation,metadata,effective_pricing_model,desired_pricing_model)
    VALUES ($1,$2,$3,'personal-test',$1::uuid::text || '.example',2,'account-prepaid','ready','running',1,'retained-disk',$4,1,$5,'spot','spot')`,
    [
      vmId,
      student,
      getConfiguredBayId(),
      provider,
      {
        billing: {
          course_funding: { source, funding_epoch: epoch, binding },
          running_rates: { spot: rate, on_demand: rate },
          stopped_rate: { hourly_cost_usd: "0.01" },
        },
      },
    ],
  );
  const terms: VmPersonalFundingTerms = {
    vm_id: vmId,
    expected_funding_version: epoch,
    home_volume_ids: [],
    lane: "prepaid",
    cap_usd: "10",
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
    activation: "immediate",
    fallback_reasons: [],
  };
  // The isolated approval adapter owns the transition to approved. These fixtures
  // start after it; runtime code must still refuse pending or changed consent.
  await getPool().query(
    `INSERT INTO compute_vm_personal_consents (id,payer_account_id,vm_id,operation_id,terms,review,state,version,approval_url,approval_expires_at)
    VALUES ($1,$2,$3,$4,$5,'{}','approved',2,'https://approval.example/funding/test',NOW()+interval '15 minutes')`,
    [consentId, student, vmId, randomUUID(), terms],
  );
  const opts = {
    account_id: student,
    vm_id: vmId,
    consent_id: consentId,
    expected_version: 2,
    expected_funding_version: epoch,
    operation_id: randomUUID(),
  };
  return { payer, student, vmId, consentId, binding, terms, opts };
}

it.each([{ limit_usd: "0" }, { limit_usd: "100", expires_at: Date.now() - 1 }])(
  "does not activate personal funding with an unavailable deployment budget %j",
  async (budget) => {
    const f = await fixture();
    await switchVmPersonalFunding(f.opts);
    await getPool().query(
      "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
      [f.vmId],
    );
    const load = jest
      .spyOn(exposure, "loadFundingExposureBudget")
      .mockResolvedValue(budget);
    await processVmPersonalFundingHandoffs();
    expect(load).toHaveBeenCalledWith(getConfiguredBayId());
    expect((await getComputeVmById(f.vmId))!.desired_state).toBe("stopped");
    expect(
      (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
        .state,
    ).toBe("preparing");
    expect(
      (
        await getPool().query(
          "SELECT id FROM account_funding_holds WHERE source_kind='resource' AND source_id=$1",
          [f.consentId],
        )
      ).rows,
    ).toEqual([]);
    load.mockRestore();
    await processVmPersonalFundingHandoffs();
    expect(
      (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
        .state,
    ).toBe("active");
  },
);

it("requires approved consent, reserves personal backing before worker restart, and settles both payers without overlap", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET state='pending' WHERE id=$1",
    [f.consentId],
  );
  await expect(switchVmPersonalFunding(f.opts)).rejects.toThrow(
    /isolated-approved/,
  );
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET state='approved' WHERE id=$1",
    [f.consentId],
  );
  expect((await switchVmPersonalFunding(f.opts)).state).toBe("preparing");
  expect((await getComputeVmById(f.vmId))!.desired_state).toBe("stopped");
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("preparing");
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  const vm = (await getComputeVmById(f.vmId))!;
  const binding = courseVmBinding(vm);
  expect(binding.source).toEqual({ kind: "personal", consent_id: f.consentId });
  expect(vm.owner_account_id).toBe(f.student);
  expect(binding.resource_generation).toBe(2);
  expect(vm.desired_state).toBe("running");
  const { rows: instances } = await getPool().query(
    "SELECT generation,running_at FROM compute_vm_instances WHERE vm_id=$1",
    [vm.id],
  );
  expect(instances).toEqual([{ generation: 2, running_at: null }]);
  const {
    rows: [hold],
  } = await getPool().query(
    "SELECT remaining_usd FROM account_funding_holds WHERE source_kind='resource' AND source_id=$1",
    [binding.reservation_id],
  );
  expect(Number(hold.remaining_usd)).toBeGreaterThan(0);
  expect(Number(hold.remaining_usd)).toBeLessThanOrEqual(10);
  expect((await switchVmPersonalFunding(f.opts)).state).toBe("active");
  await checkComputeVmFundingLocal({
    account_id: f.student,
    binding,
    dispatch: true,
  });
  await updateComputeInstance(vm, { running: true, ready: true });
  await meterCourseVm(vm);
  const {
    rows: [personalMeter],
  } = await getPool().query(
    "SELECT pricing_snapshot#>>'{meter,running_started_at}' AS running_at FROM compute_funding_reservations WHERE id=$1",
    [binding.reservation_id],
  );
  expect(personalMeter.running_at).toEqual(expect.any(String));
  const {
    rows: [old],
  } = await getPool().query(
    "SELECT state,spent_usd,released_usd FROM compute_funding_reservations WHERE id=$1",
    [f.binding.reservation_id],
  );
  expect(old.state).toBe("settled");
  expect(Number(old.released_usd)).toBeGreaterThan(0);
  const consent = (await getVmPersonalFunding({
    account_id: f.student,
    vm_id: f.vmId,
  }))!;
  expect(
    (
      await clearVmPersonalFunding({
        account_id: f.student,
        vm_id: f.vmId,
        consent_id: consent.id,
        expected_version: consent.version,
        operation_id: randomUUID(),
      })
    ).state,
  ).toBe("cancelled");
  await expect(
    checkComputeVmFundingLocal({
      account_id: f.student,
      binding,
      dispatch: true,
    }),
  ).rejects.toThrow(/authorization ended/);
});

it("cannot start personal compute while old GCP egress is unmeasured", async () => {
  const f = await fixture("gcp");
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
});

it("fully reserves personal admission while preserving an earlier stop and deletion deadline", async () => {
  const f = await fixture();
  const stop = new Date(Date.now() + 6 * 60_000);
  const deletion = new Date(Date.now() + 18 * 60_000);
  f.terms.ends_at = deletion.toISOString();
  await getPool().query(
    "UPDATE compute_vms SET stop_at=$2,expires_at=$3 WHERE id=$1",
    [f.vmId, stop, deletion],
  );
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=$2 WHERE id=$1",
    [f.consentId, f.terms],
  );
  await expect(
    previewVmPersonalFunding({ account_id: f.student, terms: f.terms }),
  ).resolves.toMatchObject({ terms: { ...f.terms, cap_usd: "10.0000000000" } });
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  const vm = (await getComputeVmById(f.vmId))!;
  const binding = courseVmBinding(vm);
  expect(binding.source.kind).toBe("personal");
  expect(vm.stop_at).toEqual(stop);
  expect(vm.expires_at).toEqual(deletion);
  expect(Date.parse(binding.stop_at)).toBeLessThanOrEqual(stop.valueOf());
  expect(Date.parse(binding.authorized_until)).toBeLessThanOrEqual(
    deletion.valueOf(),
  );
  expect(Date.parse(binding.storage_delete_at)).toBe(deletion.valueOf());
  // The six-minute timer does not lower the minimum financial reservation.
  expect(Number(binding.authorized_usd)).toBeGreaterThan(2.5);
  expect(Number(binding.authorized_usd)).toBeLessThanOrEqual(10);
  await processVmPersonalFundingHandoffs();
  expect(
    courseVmBinding((await getComputeVmById(f.vmId))!).reservation_id,
  ).toBe(binding.reservation_id);
});

async function fallbackFixture(
  reason: "course_expired" | "course_exhausted" = "course_expired",
  provider: "gcp" | "nebius" = "nebius",
) {
  const f = await fixture(provider);
  f.terms.activation = "fallback";
  f.terms.fallback_reasons = [reason];
  f.binding.stop_at = new Date(Date.now() - 1000).toISOString();
  f.binding.authorized_until = new Date(Date.now() + 5 * 60_000).toISOString();
  await getPool().query(
    "UPDATE compute_funding_reservations SET authorized_until=$3,pricing_snapshot=jsonb_set(pricing_snapshot,'{binding}',$2::jsonb) WHERE id=$1",
    [
      f.binding.reservation_id,
      JSON.stringify(f.binding),
      f.binding.authorized_until,
    ],
  );
  await getPool().query(
    "UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,course_funding,binding}',$2::jsonb) WHERE id=$1",
    [f.vmId, JSON.stringify(f.binding)],
  );
  if (f.binding.source.kind !== "course") throw Error("fixture source");
  if (reason === "course_expired")
    await getPool().query(
      "UPDATE compute_funding_grants SET ends_at=NOW() WHERE id=$1",
      [f.binding.source.grant_id],
    );
  else
    await getPool().query(
      "UPDATE compute_funding_grants SET authorized_usd=spent_usd+reserved_usd+released_usd WHERE id=$1",
      [f.binding.source.grant_id],
    );
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=$2,review=$3 WHERE id=$1",
    [
      f.consentId,
      f.terms,
      {
        resource_generation: 1,
        hourly_usd: "6",
        egress_cap_usd: provider === "gcp" ? "1" : "0",
      },
    ],
  );
  await enqueueCourseFundingDeadlines();
  expect(
    (await getComputeVmById(f.vmId))!.metadata.billing.course_funding
      .stop_intent,
  ).toBeDefined();
  // The provider-stop worker persists this edge; no provider calls in this suite.
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  return f;
}

it.each(["course_expired", "course_exhausted"] as const)(
  "automatic %s uses approved scope, prepares personal backing, and queues only one new generation",
  async (reason) => {
    const f = await fallbackFixture(reason);
    expect(
      (
        await getComputeVmFallbackDecisionLocal({
          account_id: f.payer,
          binding: f.binding,
        })
      ).reason,
    ).toBe(reason);
    await processVmPersonalFundingHandoffs();
    await processVmPersonalFundingHandoffs();
    const vm = (await getComputeVmById(f.vmId))!;
    expect(vm.owner_account_id).toBe(f.student);
    expect(courseVmBinding(vm).source).toEqual({
      kind: "personal",
      consent_id: f.consentId,
    });
    expect(vm.instance_generation).toBe(2);
    expect(
      (
        await getPool().query(
          "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1 AND resource_id=$2",
          [f.student, f.vmId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
        .state,
    ).toBe("active");
  },
);

it.each([
  "unapproved",
  "different-reason",
  "revoked",
  "suspended",
  "user-stop",
  "timer",
  "provider-error",
  "changed-version",
  "payer-outage",
  "personal-unfunded",
  "refilled",
])("does not infer automatic fallback from %s", async (failure) => {
  const f = await fallbackFixture();
  if (f.binding.source.kind !== "course") throw Error("fixture source");
  if (failure === "unapproved")
    await getPool().query(
      "UPDATE compute_vm_personal_consents SET state='pending' WHERE id=$1",
      [f.consentId],
    );
  if (failure === "different-reason")
    await getPool().query(
      "UPDATE compute_vm_personal_consents SET terms=jsonb_set(terms,'{fallback_reasons}','[\"course_exhausted\"]') WHERE id=$1",
      [f.consentId],
    );
  if (failure === "revoked")
    await getPool().query(
      "UPDATE compute_funding_grants SET state='revoked' WHERE id=$1",
      [f.binding.source.grant_id],
    );
  if (failure === "suspended") setPolicy(f.payer, { can_create_hosts: false });
  if (failure === "personal-unfunded")
    await getPool().query(
      "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,10,'other',NOW())",
      [f.student],
    );
  if (failure === "refilled")
    await getPool().query(
      "UPDATE compute_funding_grants SET ends_at=NOW()+interval '1 day' WHERE id=$1",
      [f.binding.source.grant_id],
    );
  if (failure === "user-stop") {
    await requestScheduledVmState({
      vm: (await getComputeVmById(f.vmId))!,
      desired_state: "stopped",
      actor_kind: "human",
      idempotency_key: randomUUID(),
    });
    await getPool().query(
      "UPDATE compute_vms SET state='stopped' WHERE id=$1",
      [f.vmId],
    );
  }
  if (failure === "timer")
    await getPool().query("UPDATE compute_vms SET stop_at=NOW() WHERE id=$1", [
      f.vmId,
    ]);
  if (failure === "provider-error")
    await getPool().query(
      "UPDATE compute_vms SET error='provider observation unavailable' WHERE id=$1",
      [f.vmId],
    );
  if (failure === "changed-version")
    await getPool().query(
      "UPDATE compute_vm_personal_consents SET terms=jsonb_set(terms,'{expected_funding_version}',to_jsonb($2::text)) WHERE id=$1",
      [f.consentId, randomUUID()],
    );
  if (failure === "payer-outage")
    jest
      .spyOn(await payerApi(f.payer), "getComputeVmFallbackDecision")
      .mockRejectedValue(Error("payer unavailable"));
  await processVmPersonalFundingHandoffs();
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
  expect(
    (
      await getPool().query(
        "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1 AND resource_id=$2",
        [f.student, f.vmId],
      )
    ).rows,
  ).toHaveLength(0);
});

it("cancellation between the payer reason reply and preparation wins the version fence", async () => {
  const f = await fallbackFixture();
  const api = await payerApi(f.payer);
  const original = api.getComputeVmFallbackDecision;
  jest
    .spyOn(api, "getComputeVmFallbackDecision")
    .mockImplementation(async (request) => {
      const decision = await original(request);
      if (request.binding.reservation_id !== f.binding.reservation_id)
        return decision;
      await clearVmPersonalFunding({
        account_id: f.student,
        vm_id: f.vmId,
        consent_id: f.consentId,
        expected_version: 2,
        operation_id: randomUUID(),
      });
      return decision;
    });
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("cancelled");
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
});

it("automatic GCP fallback waits for payer and resource egress watermarks", async () => {
  const f = await fallbackFixture("course_expired", "gcp");
  await processVmPersonalFundingHandoffs();
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
  await getPool().query(
    "UPDATE compute_funding_reservations SET pricing_snapshot=jsonb_set(pricing_snapshot,'{meter}',$2::jsonb) WHERE id=$1",
    [
      f.binding.reservation_id,
      JSON.stringify({
        egress_complete_through: new Date().toISOString(),
        public_egress_bytes: 0,
      }),
    ],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("preparing");
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
  await getPool().query(
    "UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,egress}',$2::jsonb) WHERE id=$1",
    [
      f.vmId,
      JSON.stringify({
        metered_through_at: new Date().toISOString(),
        total_bytes: 0,
      }),
    ],
  );
  await processVmPersonalFundingHandoffs();
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "personal",
  );
});

it("releases the old GCP reservation when network accounting covers the stop but precedes storage handoff", async () => {
  const f = await fixture("gcp");
  await switchVmPersonalFunding(f.opts);
  const stoppedAt = new Date(Date.now() - 20_000).toISOString();
  const completeThrough = new Date(Date.now() - 10_000).toISOString();
  await getPool().query(
    `UPDATE compute_vms SET state='stopped',stopped_at=$2,
      metadata=jsonb_set(metadata,'{billing,egress}',$3::jsonb) WHERE id=$1`,
    [
      f.vmId,
      stoppedAt,
      JSON.stringify({ metered_through_at: completeThrough, total_bytes: 0 }),
    ],
  );
  await processVmPersonalFundingHandoffs();
  const vm = (await getComputeVmById(f.vmId))!;
  expect(courseVmBinding(vm).source.kind).toBe("personal");
  const prior = vm.metadata.billing.course_funding.history[0];
  expect(new Date(prior.transferred_at).valueOf()).toBeGreaterThan(
    Date.parse(completeThrough),
  );
  await meterCourseVm(vm);
  const {
    rows: [old],
  } = await getPool().query(
    "SELECT state,released_usd FROM compute_funding_reservations WHERE id=$1",
    [f.binding.reservation_id],
  );
  expect(old.state).toBe("settled");
  expect(Number(old.released_usd)).toBeGreaterThan(0);
  await meterCourseVm(vm);
  expect(
    (
      await getPool().query(
        "SELECT state,released_usd FROM compute_funding_reservations WHERE id=$1",
        [f.binding.reservation_id],
      )
    ).rows[0],
  ).toEqual(old);
});

it("does not release old funding for a missing or mismatched successor", async () => {
  const f = await fixture();
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  const vm = (await getComputeVmById(f.vmId))!;
  const prior = vm.metadata.billing.course_funding.history[0];
  const request = {
    account_id: f.payer,
    binding: f.binding,
    running_until: prior.running_until,
    stopped_until: prior.transferred_at,
    transferred_at: prior.transferred_at,
    successor_reservation_id: prior.successor_reservation_id,
    successor_binding: prior.successor_binding,
  };
  for (const change of [
    { resource_id: randomUUID() },
    { owner_account_id: randomUUID() },
    { owning_bay_id: "wrong-bay" },
    { resource_generation: 1 },
    { reservation_id: randomUUID() },
  ])
    await expect(
      settleComputeVmFundingLocal({
        ...request,
        successor_binding: { ...request.successor_binding, ...change },
      }),
    ).rejects.toThrow(/successor funding identity/);
  const api = await payerApi(f.student);
  const lookup = jest
    .spyOn(api, "lookupComputeVmFunding")
    .mockResolvedValue(null);
  await expect(settleComputeVmFundingLocal(request)).rejects.toThrow(
    /has not committed/,
  );
  lookup.mockRejectedValue(new Error("successor payer unavailable"));
  await expect(settleComputeVmFundingLocal(request)).rejects.toThrow(
    /unavailable/,
  );
  expect(
    (
      await getPool().query(
        "SELECT released_usd FROM compute_funding_reservations WHERE id=$1",
        [f.binding.reservation_id],
      )
    ).rows[0].released_usd,
  ).toBe("0.0000000000");
  lookup.mockRestore();
  await meterCourseVm(vm);
  expect(
    (
      await getPool().query(
        "SELECT state FROM compute_funding_reservations WHERE id=$1",
        [f.binding.reservation_id],
      )
    ).rows[0].state,
  ).toBe("settled");
});

it("uses postpaid only when that exact lane is in the isolated-approved fallback", async () => {
  const f = await fallbackFixture();
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=jsonb_set(terms,'{lane}','\"postpaid\"') WHERE id=$1",
    [f.consentId],
  );
  await processVmPersonalFundingHandoffs();
  const vm = (await getComputeVmById(f.vmId))!;
  expect(courseVmBinding(vm).source.kind).toBe("personal");
  expect(vm.funding_mode).toBe("account-postpaid");
});

it("rotates the handoff batch so twenty blocked consents do not starve another VM", async () => {
  const f = await fixture();
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  const blocked: string[] = [];
  try {
    for (let i = 1; i <= 20; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      blocked.push(id);
      await getPool().query(
        `INSERT INTO compute_vm_personal_consents
        (id,payer_account_id,vm_id,operation_id,terms,review,state,version,approval_url,approval_expires_at,handoff)
        SELECT $1,payer_account_id,vm_id,$2,terms,review,'preparing',version,approval_url,approval_expires_at,'{"stop_generation":-1}'
        FROM compute_vm_personal_consents WHERE id=$3`,
        [id, randomUUID(), f.consentId],
      );
    }
    await processVmPersonalFundingHandoffs();
    expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
      "course",
    );
    await processVmPersonalFundingHandoffs();
    expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
      "personal",
    );
  } finally {
    await getPool().query(
      "DELETE FROM compute_vm_personal_consents WHERE id=ANY($1::uuid[]) AND payer_account_id=$2",
      [blocked, f.student],
    );
  }
});

it("does not infer personal eligibility from having a course allowance", async () => {
  const f = await fixture();
  setPolicy(f.student, {
    has_active_second_factor: false,
    has_payment_method: false,
    can_create_hosts: false,
  });
  await expect(
    previewVmPersonalFunding({ account_id: f.student, terms: f.terms }),
  ).rejects.toThrow(/membership does not allow/);
  setPolicy(f.student, {
    has_active_second_factor: false,
    has_payment_method: false,
    can_create_hosts: true,
  });
  await expect(
    previewVmPersonalFunding({ account_id: f.student, terms: f.terms }),
  ).rejects.toThrow(/enable two-factor/);
});

it("reserves a new sponsored generation before scheduled restart and replays without another reservation", async () => {
  const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "restart-test";
  try {
    const f = await fixture();
    await getPool().query(
      "UPDATE compute_vms SET state='stopped',desired_state='stopped',stopped_at=NOW() WHERE id=$1",
      [f.vmId],
    );
    const vm = (await getComputeVmById(f.vmId))!;
    const operation = randomUUID();
    const prepared = await prepareCourseVmRestart(vm, operation, null);
    expect(prepared!.binding.resource_generation).toBe(2);
    expect(
      courseVmBinding((await getComputeVmById(vm.id))!).funding_epoch,
    ).toBe(f.binding.funding_epoch);
    const restarted = await requestScheduledVmState({
      vm,
      desired_state: "running",
      actor_kind: "owner",
      idempotency_key: operation,
      prepared_funding: prepared,
    });
    expect(courseVmBinding(restarted).funding_epoch).toBe(
      prepared!.binding.funding_epoch,
    );
    expect(restarted.stopped_at).toBeNull();
    expect(
      (
        await getPool().query(
          "SELECT generation,running_at FROM compute_vm_instances WHERE vm_id=$1",
          [vm.id],
        )
      ).rows,
    ).toEqual([{ generation: 2, running_at: null }]);
    expect(await prepareCourseVmRestart(vm, operation, null)).toBeUndefined();
    const {
      rows: [count],
    } = await getPool().query(
      "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE resource_id=$1",
      [vm.id],
    );
    expect(count.n).toBe(2);
    await checkComputeVmFundingLocal({
      account_id: f.payer,
      binding: prepared!.binding,
      dispatch: true,
    });
    await meterCourseVm(restarted);
    const {
      rows: [previous],
    } = await getPool().query(
      "SELECT state FROM compute_funding_reservations WHERE id=$1",
      [f.binding.reservation_id],
    );
    expect(previous.state).toBe("settled");
  } finally {
    if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
  }
});
