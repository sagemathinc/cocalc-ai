/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SCHEMA } from "@cocalc/util/schema";
import { syncTableSchemaColumnInvariants } from "@cocalc/database/postgres/schema/column-invariants";
import getPool, { getClient } from "@cocalc/database/pool";
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
  publicVmFundingStatus,
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
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import {
  previewVolumePersonalFunding,
  proposeVolumePersonalFunding,
  getVolumePersonalFunding,
  approvePersonalVolumeFunding,
  reviewPersonalVolumeFunding,
  switchVolumePersonalFunding,
  clearVolumePersonalFunding,
  closeEndedVolumePersonalConsents,
} from "./volume-personal";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import { recoverTerminalCourseVmFunding } from "./vm-worker-recovery";
import { getComputeVolumeById } from "../volume-db";
import {
  reserveCourseVolumeGrowth,
  recordCourseVolumeGrowth,
} from "./volume-growth";
import {
  reserveCourseVolume,
  courseVolumeBinding,
  meterCourseVolume,
  requireCourseVolumeService,
  endCourseVolumeService,
  publicVolumeFundingStatus,
} from "./volume-funding";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("./approvals", () => ({
  assertFundingPayerHomeBay: async () => {},
  proposeVmPersonalFundingApproval: jest.fn(),
  proposeVolumePersonalFundingApproval: jest.fn(async () => ({
    intent_id: require("node:crypto").randomUUID(),
    approval_url: "https://approval.example/storage",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  })),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));

const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
// PGlite does not expose independent backend lock waits in pg_stat_activity.
const postgresIt = process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
beforeAll(async () => {
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "personal-volume-funding-test";
  await before({ noConat: true });
}, 60_000);
const fixtures = fundingResourceFixtures();
const homeFixtureIds = new Set<string>();
afterEach(async () => {
  jest.restoreAllMocks();
  for (const id of homeFixtureIds) {
    await getPool().query(
      "UPDATE compute_vms SET home_volume_id=NULL,desired_state='deleted',deleted_at=NOW() WHERE home_volume_id=$1",
      [id],
    );
    await getPool().query("DELETE FROM compute_volumes WHERE id=$1", [id]);
  }
  homeFixtureIds.clear();
  await fixtures.cleanup();
});
afterAll(async () => {
  try {
    await fixtures.cleanup();
  } finally {
    await after();
    if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
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

async function fixtureWithHome() {
  const f = await fixture("gcp");
  const volumeId = randomUUID(),
    epoch = randomUUID();
  homeFixtureIds.add(volumeId);
  await getPool().query(
    `INSERT INTO compute_volumes (id,name,owner_account_id,owning_bay_id,provider,region,zone,role,funding_mode,
    size_gb,desired_size_gb,effective_size_gb,state,desired_state,attachment_state,attached_vm_id,attachment_generation,created_at,ready_at,metadata)
    VALUES ($1,'personal-home',$2,$3,'gcp','us-central1','us-central1-a','home','account-prepaid',10,10,10,'ready','ready','attached',$4,1,NOW(),NOW()-interval '1 minute',$5)`,
    [
      volumeId,
      f.student,
      getConfiguredBayId(),
      f.vmId,
      {
        billing: {
          rate: {
            hourly_cost_usd: "0.01",
            pricing_snapshot: { provider: "gcp" },
          },
          course_funding: {
            source: { ...f.binding.source, payer_account_id: f.payer },
            funding_epoch: epoch,
          },
        },
      },
    ],
  );
  const volume = await reserveCourseVolume(
    (await getComputeVolumeById(volumeId))!,
  );
  await requireCourseVolumeService(volume, true);
  await getPool().query(
    "UPDATE compute_funding_reservations SET dispatched_at=NOW()-interval '2 minutes' WHERE id=$1",
    [courseVolumeBinding(volume).reservation_id],
  );
  await getPool().query(
    "UPDATE compute_vms SET home_volume_id=$2 WHERE id=$1",
    [f.vmId, volumeId],
  );
  f.terms.home_volume_ids = [volumeId];
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=$2,review=$3 WHERE id=$1",
    [
      f.consentId,
      f.terms,
      {
        home_volumes: [
          {
            id: volumeId,
            name: volume.name,
            funding_epoch: epoch,
            resource_generation: 1,
            attachment_generation: 1,
            size_gb: 10,
            hourly_usd: "0.01",
          },
        ],
      },
    ],
  );
  return { ...f, volumeId, volume, volumeBinding: courseVolumeBinding(volume) };
}

async function stopForHomeHandoff(
  f: Awaited<ReturnType<typeof fixtureWithHome>>,
) {
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    `UPDATE compute_vms SET state='stopped',stopped_at=NOW(),
    metadata=jsonb_set(metadata,'{billing,egress}',jsonb_build_object('metered_through_at',clock_timestamp(),'total_bytes',0)) WHERE id=$1`,
    [f.vmId],
  );
}

async function standaloneVolumeConsent() {
  const f = await fixtureWithHome();
  await getPool().query(
    "UPDATE compute_vms SET home_volume_id=NULL,desired_state='deleted',deleted_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await getPool().query(
    "UPDATE compute_volumes SET attached_vm_id=NULL,attachment_state='detached',attachment_generation=attachment_generation+1 WHERE id=$1",
    [f.volumeId],
  );
  const terms = {
    volume_id: f.volumeId,
    expected_funding_version: f.volumeBinding.funding_epoch,
    lane: "prepaid" as const,
    cap_usd: "2",
    ends_at: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
  const opts = { account_id: f.student, terms, operation_id: randomUUID() };
  const preview = await previewVolumePersonalFunding(opts);
  const consent = await proposeVolumePersonalFunding(opts);
  const review = await reviewPersonalVolumeFunding(f.student, terms);
  return { ...f, terms, preview, consent, review };
}

async function fixtureWithPersonalHome() {
  const f = await fixture("gcp");
  const volumeId = randomUUID();
  homeFixtureIds.add(volumeId);
  await getPool().query(
    `INSERT INTO compute_volumes (id,name,owner_account_id,owning_bay_id,provider,region,zone,role,funding_mode,
      size_gb,desired_size_gb,state,desired_state,attachment_state,attached_vm_id,attachment_generation,ready_at,metadata)
      VALUES ($1,'independent-home',$2,$3,'gcp','us-central1','us-central1-a','home','account-prepaid',10,10,'ready','ready','attached',$4,1,NOW(),$5)`,
    [
      volumeId,
      f.student,
      getConfiguredBayId(),
      f.vmId,
      { billing: { rate: { hourly_cost_usd: "0.01" } } },
    ],
  );
  await getPool().query(
    "UPDATE compute_vms SET home_volume_id=$2 WHERE id=$1",
    [f.vmId, volumeId],
  );
  f.terms.home_volume_ids = [volumeId];
  const preview = await previewVmPersonalFunding({
    account_id: f.student,
    terms: f.terms,
  });
  expect(preview.home_volumes![0]).toMatchObject({
    id: volumeId,
    funding_action: "preserve",
  });
  expect(preview.home_volumes![0].storage_delete_at).toBeUndefined();
  const volume = (await getComputeVolumeById(volumeId))!;
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=$2,review=$3 WHERE id=$1",
    [
      f.consentId,
      f.terms,
      {
        home_volumes: [
          {
            ...preview.home_volumes![0],
            funding_mode: volume.funding_mode,
            attachment_generation: 1,
            size_gb: 10,
          },
        ],
      },
    ],
  );
  return { ...f, volumeId, volume };
}

it("preserves an existing personal home disk and charges only the VM against its new cap", async () => {
  const f = await fixtureWithPersonalHome();
  const { volumeId, volume } = f;
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW(),metadata=jsonb_set(metadata,'{billing,egress}',jsonb_build_object('metered_through_at',clock_timestamp(),'total_bytes',0)) WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("active");
  expect(await getComputeVolumeById(volumeId)).toEqual(volume);
  expect(
    (
      await getPool().query(
        "SELECT resource_id,resource_kind FROM compute_funding_reservations WHERE payer_account_id=$1",
        [f.student],
      )
    ).rows,
  ).toEqual([{ resource_id: f.vmId, resource_kind: "compute-vm" }]);
});

it("rejects incomplete home funding instead of treating it as an ordinary personal disk", async () => {
  const f = await fixtureWithPersonalHome();
  await getPool().query(
    "UPDATE compute_volumes SET metadata=jsonb_set(metadata,'{billing,course_funding}',$2::jsonb) WHERE id=$1",
    [f.volumeId, JSON.stringify({ funding_epoch: randomUUID() })],
  );
  await expect(
    previewVmPersonalFunding({ account_id: f.student, terms: f.terms }),
  ).rejects.toThrow("Home volume funding is unknown");
});

it("does not apply an approved handoff after independent home funding changes", async () => {
  const f = await fixtureWithPersonalHome();
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW(),metadata=jsonb_set(metadata,'{billing,egress}',jsonb_build_object('metered_through_at',clock_timestamp(),'total_bytes',0)) WHERE id=$1",
    [f.vmId],
  );
  await getPool().query(
    "UPDATE compute_volumes SET funding_mode='account-postpaid' WHERE id=$1",
    [f.volumeId],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("preparing");
  expect(
    (
      await getPool().query(
        "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1",
        [f.student],
      )
    ).rows,
  ).toEqual([]);
  expect((await getComputeVolumeById(f.volumeId))!.funding_mode).toBe(
    "account-postpaid",
  );
});

it("retries contended meter locks before financial work, without repeating a void callback", async () => {
  const db = getClient();
  await db.connect();
  const id = randomUUID();
  const key = `compute-funding-meter:vm:${id}`;
  const work = jest.fn(async () => {});
  let pending: Promise<unknown> | undefined;
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    await withFundingResourceMeterLock("vm", id, work);
    expect(work).not.toHaveBeenCalled();
    pending = withFundingResourceMeterLock("vm", id, work, {
      retryContention: true,
    });
    await delay(75);
    expect(work).not.toHaveBeenCalled();
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    await pending;
    expect(work).toHaveBeenCalledTimes(1);
    await withFundingResourceMeterLock("vm", id, work, {
      retryContention: true,
    });
    expect(work).toHaveBeenCalledTimes(2);
  } finally {
    await db.end();
    await pending;
  }
});

it("leaves persistently busy meter locks for a later sweep and does not retry failed work", async () => {
  const db = getClient();
  await db.connect();
  const id = randomUUID();
  const key = `compute-funding-meter:vm:${id}`;
  const work = jest.fn(async () => {
    throw new Error("handoff unavailable");
  });
  try {
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    await expect(
      withFundingResourceMeterLock("vm", id, work, { retryContention: true }),
    ).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    await expect(
      withFundingResourceMeterLock("vm", id, work, { retryContention: true }),
    ).rejects.toThrow("handoff unavailable");
    expect(work).toHaveBeenCalledTimes(1);
  } finally {
    await db.end();
  }
});

it("upgrades existing VM-only consents to permit exactly one standalone volume", async () => {
  const db = getClient();
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "ALTER TABLE compute_vm_personal_consents ALTER COLUMN vm_id SET NOT NULL",
    );
    await syncTableSchemaColumnInvariants(db, {
      name: "compute_vm_personal_consents",
      primary_key: "id",
      fields: SCHEMA.compute_vm_personal_consents.fields,
    });
    expect(
      (
        await db.query(
          "SELECT is_nullable FROM information_schema.columns WHERE table_name='compute_vm_personal_consents' AND column_name='vm_id'",
        )
      ).rows[0].is_nullable,
    ).toBe("YES");
    expect(
      (
        await db.query(
          "SELECT convalidated FROM pg_constraint WHERE conrelid='compute_vm_personal_consents'::regclass AND conname='compute_personal_consents_resource'",
        )
      ).rows[0].convalidated,
    ).toBe(true);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

async function approveStandalone(
  f: Awaited<ReturnType<typeof standaloneVolumeConsent>>,
) {
  await withFundingAccountTransaction(f.student, (db) =>
    approvePersonalVolumeFunding({
      db,
      payer_account_id: f.student,
      intent_id: f.consent.id,
      terms: f.terms,
      review: f.review,
    }),
  );
  const approved = (await getVolumePersonalFunding({
    account_id: f.student,
    volume_id: f.volumeId,
  }))!;
  return {
    account_id: f.student,
    volume_id: f.volumeId,
    consent_id: approved.id,
    expected_version: approved.version,
    operation_id: randomUUID(),
  };
}

it("funds detached storage after VM deletion through proposal, approval, one cutover, and cancellation", async () => {
  const f = await standaloneVolumeConsent();
  expect(f.preview.volume_name).toBe(f.volume.name);
  expect(f.consent.state).toBe("pending");
  const request = await approveStandalone(f);
  const applied = await switchVolumePersonalFunding(request);
  expect(applied.state).toBe("active");
  expect(await switchVolumePersonalFunding(request)).toEqual(applied);
  const volume = (await getComputeVolumeById(f.volumeId))!;
  const binding = courseVolumeBinding(volume);
  expect(binding.source).toEqual({
    kind: "personal",
    consent_id: f.consent.id,
  });
  expect(Date.parse(binding.storage_delete_at)).toBeLessThanOrEqual(
    Date.parse(f.preview.storage_delete_at),
  );
  expect((await getComputeVmById(f.vmId))!.desired_state).toBe("deleted");
  await meterCourseVolume(volume);
  expect(
    (
      await getPool().query(
        "SELECT state FROM compute_funding_reservations WHERE id=$1",
        [f.volumeBinding.reservation_id],
      )
    ).rows[0].state,
  ).toBe("settled");
  const cancel = {
    ...request,
    expected_version: applied.version,
    operation_id: randomUUID(),
  };
  expect((await clearVolumePersonalFunding(cancel)).state).toBe("cancelled");
  await expect(requireCourseVolumeService(volume)).rejects.toThrow(
    "authorization ended",
  );
  expect((await getComputeVolumeById(f.volumeId))!.desired_state).toBe("ready");
  await getPool().query(
    "UPDATE compute_volumes SET deleted_at=NOW(),desired_state='deleted' WHERE id=$1",
    [f.volumeId],
  );
  await meterCourseVolume((await getComputeVolumeById(f.volumeId))!);
  expect(
    Number(
      (await getVolumePersonalFunding({
        account_id: f.student,
        volume_id: f.volumeId,
      }))!.committed_usd,
    ),
  ).toBe(0);
});

it("reads and withdraws personal storage consent without requiring a local resource row", async () => {
  const f = await standaloneVolumeConsent();
  const request = await approveStandalone(f);
  const applied = await switchVolumePersonalFunding(request);
  await getPool().query(
    "UPDATE compute_volumes SET owning_bay_id='remote-resource-bay' WHERE id=$1",
    [f.volumeId],
  );
  const before = await getComputeVolumeById(f.volumeId);
  const read = await getVolumePersonalFunding({
    account_id: f.student,
    volume_id: f.volumeId,
  });
  expect(read).toEqual(applied);
  const cancel = {
    ...request,
    expected_version: applied.version,
    operation_id: randomUUID(),
  };
  const result = await clearVolumePersonalFunding(cancel);
  expect(result.state).toBe("cancelled");
  expect(result.committed_usd).toBe(applied.committed_usd);
  expect(await clearVolumePersonalFunding(cancel)).toEqual(result);
  expect(await getComputeVolumeById(f.volumeId)).toEqual(before);
  expect(
    await getVolumePersonalFunding({
      account_id: f.payer,
      volume_id: f.volumeId,
    }),
  ).toBeNull();
  await expect(
    clearVolumePersonalFunding({ ...cancel, account_id: f.payer }),
  ).rejects.toThrow("Storage consent not found");
});

it.each(["attachment", "size", "epoch", "deletion"])(
  "rejects a changed standalone storage approval: %s",
  async (change) => {
    const f = await standaloneVolumeConsent();
    const request = await approveStandalone(f);
    const update = {
      attachment: "attachment_generation=attachment_generation+1",
      size: "size_gb=20,desired_size_gb=20",
      epoch: `metadata=jsonb_set(metadata,'{billing,course_funding,funding_epoch}',to_jsonb('${randomUUID()}'::text))`,
      deletion: "desired_state='deleted'",
    }[change]!;
    await getPool().query(`UPDATE compute_volumes SET ${update} WHERE id=$1`, [
      f.volumeId,
    ]);
    await expect(switchVolumePersonalFunding(request)).rejects.toThrow();
    expect(
      (
        await getPool().query(
          "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1",
          [f.student],
        )
      ).rows,
    ).toHaveLength(0);
  },
);

it("requires isolated approval and ownership for standalone storage and ends deleted consent without new service", async () => {
  const f = await standaloneVolumeConsent();
  const request = {
    account_id: f.student,
    volume_id: f.volumeId,
    consent_id: f.consent.id,
    expected_version: f.consent.version,
    operation_id: randomUUID(),
  };
  await expect(switchVolumePersonalFunding(request)).rejects.toThrow(
    "approved",
  );
  await expect(
    previewVolumePersonalFunding({ account_id: f.payer, terms: f.terms }),
  ).rejects.toThrow("owner");
  await getPool().query(
    "UPDATE compute_volumes SET desired_state='deleted',deleted_at=NOW() WHERE id=$1",
    [f.volumeId],
  );
  await closeEndedVolumePersonalConsents();
  expect(
    (await getVolumePersonalFunding({
      account_id: f.student,
      volume_id: f.volumeId,
    }))!.state,
  ).toBe("cancelled");
});

it("hands off the reviewed home disk once, settles its old payer, and retains independent storage after VM deletion", async () => {
  const f = await fixtureWithHome();
  f.terms.ends_at = new Date(Date.now() + 20 * 60_000).toISOString();
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=$2 WHERE id=$1",
    [f.consentId, f.terms],
  );
  const preview = await previewVmPersonalFunding({
    account_id: f.student,
    terms: f.terms,
  });
  expect(preview.home_volumes).toEqual([
    expect.objectContaining({ id: f.volumeId, hourly_usd: "0.01" }),
  ]);
  await stopForHomeHandoff(f);
  await Promise.all([
    processVmPersonalFundingHandoffs(),
    processVmPersonalFundingHandoffs(),
  ]);
  const volume = (await getComputeVolumeById(f.volumeId))!;
  const next = courseVolumeBinding(volume);
  expect(next.source).toEqual({ kind: "personal", consent_id: f.consentId });
  expect(next.resource_generation).toBe(2);
  expect(next.reservation_id).not.toBe(f.consentId);
  expect(next.egress_usd).toBe("0");
  expect(Date.parse(next.storage_delete_at)).toBeLessThanOrEqual(
    Date.parse(preview.home_volumes![0].storage_delete_at),
  );
  expect(
    (
      await getPool().query(
        "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1",
        [f.student],
      )
    ).rows,
  ).toHaveLength(2);
  await requireCourseVolumeService(volume, true, true);
  await meterCourseVolume(volume);
  await meterCourseVolume(volume);
  const old = (
    await getPool().query(
      "SELECT state,released_usd,pricing_snapshot FROM compute_funding_reservations WHERE id=$1",
      [f.volumeBinding.reservation_id],
    )
  ).rows[0];
  expect(old.state).toBe("settled");
  expect(Number(old.released_usd)).toBeGreaterThan(0);
  expect(old.pricing_snapshot.meter.transferred_at).toBe(
    volume.metadata.billing.course_funding.started_at,
  );
  await getPool().query(
    "UPDATE compute_vms SET desired_state='deleted',deleted_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("active");
  await requireCourseVolumeService((await getComputeVolumeById(f.volumeId))!);
  // A delayed course deadline cannot mutate the successor epoch.
  await endCourseVolumeService(f.volume);
  expect(
    (await getComputeVolumeById(f.volumeId))!.metadata.billing.course_funding
      .service_ended_at,
  ).toBeUndefined();
  await getPool().query(
    "UPDATE compute_volumes SET desired_state='deleted',deleted_at=NOW() WHERE id=$1",
    [f.volumeId],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
      .state,
  ).toBe("cancelled");
  await meterCourseVolume((await getComputeVolumeById(f.volumeId))!);
  expect(
    publicVolumeFundingStatus((await getComputeVolumeById(f.volumeId))!),
  ).toMatchObject({
    label: "Personal funding",
    state: "closed",
    committed_usd: "0.0000000000",
  });
});

it("does not cut over while an old home-volume meter is awaiting its payer", async () => {
  const f = await fixtureWithHome();
  await stopForHomeHandoff(f);
  const api = await payerApi(f.payer);
  const settle = api.settleComputeVmFunding;
  let entered!: () => void;
  const enteredMeter = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .spyOn(api, "settleComputeVmFunding")
    .mockImplementation(async (request) => {
      if (request.binding.reservation_id === f.volumeBinding.reservation_id) {
        entered();
        await released;
      }
      return settle(request);
    });
  const metering = meterCourseVolume(f.volume);
  try {
    await enteredMeter;
    await processVmPersonalFundingHandoffs();
    expect(
      courseVolumeBinding((await getComputeVolumeById(f.volumeId))!).source
        .kind,
    ).toBe("course");
  } finally {
    release();
    await metering;
  }
  await processVmPersonalFundingHandoffs();
  const volume = (await getComputeVolumeById(f.volumeId))!;
  expect(courseVolumeBinding(volume).source.kind).toBe("personal");
  await meterCourseVolume(volume);
  const {
    rows: [old],
  } = await getPool().query(
    "SELECT state,pricing_snapshot FROM compute_funding_reservations WHERE id=$1",
    [f.volumeBinding.reservation_id],
  );
  expect(old.state).toBe("settled");
  expect(old.pricing_snapshot.meter.running_until).toBe(
    volume.metadata.billing.course_funding.started_at,
  );
});

it("skips VM and volume observations while a handoff holds their meter locks", async () => {
  const f = await fixtureWithHome();
  const spy = jest.spyOn(await payerApi(f.payer), "settleComputeVmFunding");
  await withFundingResourceMeterLock("vm", f.vmId, async () => {
    await withFundingResourceMeterLock("volume", f.volumeId, async () => {
      await meterCourseVm((await getComputeVmById(f.vmId))!);
      await meterCourseVolume(f.volume);
    });
  });
  expect(spy).not.toHaveBeenCalled();
});

it("settles a confirmed cutover after a legacy late observation without reversing posted charges", async () => {
  const f = await fixtureWithHome();
  await stopForHomeHandoff(f);
  await processVmPersonalFundingHandoffs();
  const volume = (await getComputeVolumeById(f.volumeId))!;
  const cutover = Date.parse(volume.metadata.billing.course_funding.started_at);
  // Reproduce an old worker that read the previous epoch while cutover committed.
  await getPool().query("SELECT pg_sleep(0.025)");
  const late = new Date(cutover + 1).toISOString();
  await settleComputeVmFundingLocal({
    account_id: f.payer,
    binding: f.volumeBinding,
    running_started_at: f.volume.ready_at!.toISOString(),
    running_until: late,
    meter_as_of: late,
  });
  await meterCourseVolume(volume);
  const {
    rows: [old],
  } = await getPool().query(
    "SELECT state,spent_usd,pricing_snapshot FROM compute_funding_reservations WHERE id=$1",
    [f.volumeBinding.reservation_id],
  );
  expect(old.state).toBe("settled");
  expect(Number(old.spent_usd)).toBe(0);
  expect(old.pricing_snapshot.meter.running_until).toBe(
    new Date(cutover).toISOString(),
  );
});

it.each(["size", "attachment", "epoch", "delete"])(
  "does not move either payer after the reviewed volume changes: %s",
  async (change) => {
    const f = await fixtureWithHome();
    await stopForHomeHandoff(f);
    const sql = {
      size: "size_gb=20,desired_size_gb=20",
      attachment: "attachment_generation=attachment_generation+1",
      epoch:
        "metadata=jsonb_set(metadata,'{billing,course_funding,funding_epoch}',to_jsonb('changed'::text))",
      delete: "desired_state='deleted'",
    }[change]!;
    await getPool().query(`UPDATE compute_volumes SET ${sql} WHERE id=$1`, [
      f.volumeId,
    ]);
    await processVmPersonalFundingHandoffs();
    expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
      "course",
    );
    expect(
      (
        await getPool().query(
          "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1",
          [f.student],
        )
      ).rows,
    ).toHaveLength(0);
  },
);

it("settles every existing disk growth slice at the same personal cutover", async () => {
  const f = await fixtureWithHome();
  let volume = await reserveCourseVolumeGrowth(f.volume, {
    operation_id: randomUUID(),
    expected_funding_version: f.volumeBinding.funding_epoch,
    size_gb: 20,
    rate: { hourly_cost_usd: "0.02", pricing_snapshot: { provider: "gcp" } },
  });
  await requireCourseVolumeService(volume, true);
  await recordCourseVolumeGrowth(volume, 20);
  await getPool().query(
    "UPDATE compute_volumes SET size_gb=20,state='ready' WHERE id=$1",
    [f.volumeId],
  );
  await getPool().query(
    `UPDATE compute_vm_personal_consents SET review=jsonb_set(jsonb_set(review,'{home_volumes,0,size_gb}','20'),'{home_volumes,0,hourly_usd}','"0.02"') WHERE id=$1`,
    [f.consentId],
  );
  await stopForHomeHandoff(f);
  await processVmPersonalFundingHandoffs();
  volume = (await getComputeVolumeById(f.volumeId))!;
  expect(volume.metadata.billing.course_funding.history).toHaveLength(2);
  expect(volume.metadata.billing.course_funding.growth).toBeUndefined();
  await meterCourseVolume(volume);
  const rows = (
    await getPool().query(
      "SELECT state,pricing_snapshot FROM compute_funding_reservations WHERE payer_account_id=$1 AND resource_id=$2",
      [f.payer, f.volumeId],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.state).toBe("settled");
    expect(row.pricing_snapshot.meter.transferred_at).toBe(
      volume.metadata.billing.course_funding.started_at,
    );
  }
});

postgresIt(
  "uses volume-before-VM locks while a concurrent disk operation holds the volume",
  async () => {
    const f = await fixtureWithHome();
    await stopForHomeHandoff(f);
    // The normal test pool has two connections. Keep the competing resource
    // operation outside it so this tests PostgreSQL locks, not pool starvation.
    const db = getClient();
    await db.connect();
    let handoff: Promise<void> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("SELECT id FROM compute_volumes WHERE id=$1 FOR UPDATE", [
        f.volumeId,
      ]);
      handoff = processVmPersonalFundingHandoffs();
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const { rows } = await getPool().query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM compute_volumes%'",
        );
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await db.query(
        "SELECT id FROM compute_vms WHERE id=$1 FOR UPDATE NOWAIT",
        [f.vmId],
      );
      await db.query("COMMIT");
      await handoff;
      expect(
        courseVolumeBinding((await getComputeVolumeById(f.volumeId))!).source
          .kind,
      ).toBe("personal");
    } finally {
      await db.query("ROLLBACK");
      await db.end();
      await handoff;
    }
  },
);

it("rolls back the VM reservation when the combined home-volume reservation exceeds the approved cap", async () => {
  const f = await fixtureWithHome();
  await stopForHomeHandoff(f);
  // Simulate another already-authorized resource consuming the remaining cap
  // after the preview. Reservation admission must still be atomic.
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET committed_usd=5.5 WHERE id=$1",
    [f.consentId],
  );
  await processVmPersonalFundingHandoffs();
  expect(
    (
      await getPool().query(
        "SELECT id FROM compute_funding_reservations WHERE payer_account_id=$1",
        [f.student],
      )
    ).rows,
  ).toHaveLength(0);
  expect(courseVmBinding((await getComputeVmById(f.vmId))!).source.kind).toBe(
    "course",
  );
});

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
  await getPool().query(
    "UPDATE compute_vms SET desired_state='deleted',stopped_at=clock_timestamp(),deleted_at=clock_timestamp() WHERE id=$1",
    [f.vmId],
  );
  await meterCourseVm((await getComputeVmById(f.vmId))!);
  const settled = publicVmFundingStatus((await getComputeVmById(f.vmId))!);
  expect(settled).toMatchObject({
    state: "closed",
    committed_usd: "0.0000000000",
    remaining_usd: "0.0000000000",
    protected_storage_usd: "0.0000000000",
  });
  await meterCourseVm((await getComputeVmById(f.vmId))!);
  expect(
    publicVmFundingStatus((await getComputeVmById(f.vmId))!)!.committed_usd,
  ).toBe(settled!.committed_usd);
  await getPool().query(
    "UPDATE compute_vms SET metadata=metadata #- '{billing,course_funding,committed_usd}' WHERE id=$1",
    [f.vmId],
  );
  expect(publicVmFundingStatus((await getComputeVmById(f.vmId))!)!.state).toBe(
    "settling",
  );
  // Other fixtures leave terminal VM rows behind. Recovery is paginated, so
  // this randomly assigned VM need not occur in the first bounded batch.
  const {
    rows: [{ count }],
  } = await getPool().query<{ count: string }>(
    "SELECT count(*) FROM compute_vms WHERE owning_bay_id=$1 AND deleted_at IS NOT NULL",
    [getConfiguredBayId()],
  );
  for (let batch = 0; batch <= Math.ceil(Number(count) / 20); batch++) {
    await recoverTerminalCourseVmFunding();
    if (
      publicVmFundingStatus((await getComputeVmById(f.vmId))!)!
        .committed_usd === "0.0000000000"
    )
      break;
  }
  expect(
    publicVmFundingStatus((await getComputeVmById(f.vmId))!)!.committed_usd,
  ).toBe("0.0000000000");
});

it.each(["pending", "approved", "preparing"])(
  "ends %s personal consent when VM deletion is requested",
  async (state) => {
    const f = await fixture();
    await getPool().query(
      "UPDATE compute_vm_personal_consents SET state=$2 WHERE id=$1",
      [f.consentId, state],
    );
    await getPool().query(
      "UPDATE compute_vms SET desired_state='deleted' WHERE id=$1",
      [f.vmId],
    );
    await processVmPersonalFundingHandoffs();
    const consent = await getVmPersonalFunding({
      account_id: f.student,
      vm_id: f.vmId,
    });
    expect(consent!.state).toBe("cancelled");
    expect(
      (
        await getPool().query(
          "SELECT count(*)::int AS n FROM compute_funding_reservations WHERE payer_account_id=$1",
          [f.student],
        )
      ).rows[0].n,
    ).toBe(0);
    await processVmPersonalFundingHandoffs();
    expect(
      (await getVmPersonalFunding({ account_id: f.student, vm_id: f.vmId }))!
        .version,
    ).toBe(consent!.version);
  },
);

it("expires active personal consent without releasing its existing commitments", async () => {
  const f = await fixture();
  await switchVmPersonalFunding(f.opts);
  await getPool().query(
    "UPDATE compute_vms SET state='stopped',stopped_at=NOW() WHERE id=$1",
    [f.vmId],
  );
  await processVmPersonalFundingHandoffs();
  const before = (await getVmPersonalFunding({
    account_id: f.student,
    vm_id: f.vmId,
  }))!;
  await getPool().query(
    "UPDATE compute_vm_personal_consents SET terms=jsonb_set(terms,'{ends_at}',to_jsonb((NOW()-interval '1 second')::text)) WHERE id=$1",
    [f.consentId],
  );
  await processVmPersonalFundingHandoffs();
  const after = (await getVmPersonalFunding({
    account_id: f.student,
    vm_id: f.vmId,
  }))!;
  expect(after.state).toBe("expired");
  expect(after.committed_usd).toBe(before.committed_usd);
  expect(Number(after.committed_usd)).toBeGreaterThan(0);
  await expect(
    checkComputeVmFundingLocal({
      account_id: f.student,
      binding: courseVmBinding((await getComputeVmById(f.vmId))!),
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
