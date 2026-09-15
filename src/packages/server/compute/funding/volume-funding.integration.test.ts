/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { withFundingAccountTransaction } from "./backing";
import { createCourseFundingPoolInTransaction } from "./pools";
import { setPolicy } from "./__tests__/policy-source";
import { handleComputeWork } from "../worker";
import { getComputeVolumeById, updateComputeVolume } from "../volume-db";
import {
  ensureProviderComputeVolume,
  inspectProviderComputeVolume,
  resizeProviderComputeVolume,
  deleteProviderComputeVolume,
  detachProviderComputeHomeVolume,
} from "../provider";
import {
  reserveCourseVolume,
  meterCourseVolume,
  courseVolumeBinding,
  requireCourseVolumeService,
  enforceCourseVolumeFunding,
  endCourseVolumeService,
  assertCourseVolumeAttachable,
  publicVolumeFundingStatus,
  enqueueCourseVolumeDeadlines,
} from "./volume-funding";
import { reserveCourseVolumeGrowth } from "./volume-growth";
import {
  recoverCourseVolumeFunding,
  recoverTerminalCourseVolumeFunding,
} from "./volume-recovery";
import { fundingResourceFixtures } from "./__tests__/resource-fixtures";

jest.mock("@cocalc/server/project-host/admission", () =>
  require("./__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ compute_vm_course_funding_enabled: true }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({
    home_bay_id: require("@cocalc/server/bay-config").getConfiguredBayId(),
  }),
}));
jest.mock("../provider", () => ({
  ensureProviderComputeVolume: jest.fn(),
  inspectProviderComputeVolume: jest.fn(),
  resizeProviderComputeVolume: jest.fn(),
  deleteProviderComputeVolume: jest.fn(),
  detachProviderComputeHomeVolume: jest.fn(),
}));
const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
const fixtures = fundingResourceFixtures();
beforeAll(async () => {
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "volume-funding-test";
  await before({ noConat: true });
}, 60_000);
afterAll(async () => {
  try {
    await fixtures.cleanup();
  } finally {
    await after();
    if (deployment == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = deployment;
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  (ensureProviderComputeVolume as jest.Mock).mockResolvedValue({
    size_gb: 10,
    users: [],
  });
  (inspectProviderComputeVolume as jest.Mock).mockResolvedValue({
    size_gb: 10,
    users: [],
  });
  (resizeProviderComputeVolume as jest.Mock).mockResolvedValue(undefined);
  (deleteProviderComputeVolume as jest.Mock).mockResolvedValue(undefined);
});

async function fixture(provider: "gcp" | "nebius" = "gcp") {
  const payer = randomUUID(),
    student = randomUUID(),
    id = randomUUID(),
    epoch = randomUUID();
  fixtures.add(payer, student);
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1),($2)", [
    payer,
    student,
  ]);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,-100,'credit',NOW())",
    [payer],
  );
  setPolicy(student, {
    has_active_second_factor: false,
    has_payment_method: false,
    can_create_hosts: false,
  });
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
    kind: "course",
    pool_id: allocation.pool.id,
    grant_id: allocation.grants[0].id,
    payer_account_id: payer,
  };
  await getPool().query(
    `INSERT INTO compute_volumes (id,name,owner_account_id,owning_bay_id,provider,region,zone,role,funding_mode,
    size_gb,desired_size_gb,effective_size_gb,state,desired_state,attachment_state,attachment_generation,created_at,metadata)
    VALUES ($1,'funded-home',$2,$3,$4,'us-central1','us-central1-a','home','account-prepaid',10,10,10,'requested','ready','detached',0,NOW(),$5)`,
    [
      id,
      student,
      getConfiguredBayId(),
      provider,
      {
        billing: {
          funding_mode: "account-prepaid",
          rate: { hourly_cost_usd: "0.01", pricing_snapshot: { provider } },
          course_funding: { source, funding_epoch: epoch },
        },
      },
    ],
  );
  return {
    payer,
    student,
    id,
    source,
    epoch,
    volume: (await getComputeVolumeById(id))!,
  };
}
const work = (id: string, action: string, payload = {}) =>
  handleComputeWork({
    resource_kind: "volume",
    resource_id: id,
    action,
    payload,
  } as any);

it.each(["gcp", "nebius"] as const)(
  "reserves before the actual %s worker creates storage, and failed create charges nobody",
  async (provider) => {
    const f = await fixture(provider);
    (ensureProviderComputeVolume as jest.Mock).mockImplementationOnce(
      async () => {
        const row = (await getComputeVolumeById(f.id))!;
        expect(courseVolumeBinding(row).egress_usd).toBe("0");
        const {
          rows: [reservation],
        } = await getPool().query(
          "SELECT state FROM compute_funding_reservations WHERE resource_id=$1",
          [f.id],
        );
        expect(reservation.state).toBe("dispatched");
        throw Error("provider failed before creation");
      },
    );
    await expect(work(f.id, "provision_volume")).rejects.toThrow(
      /provider failed/,
    );
    await meterCourseVolume((await getComputeVolumeById(f.id))!);
    expect(
      (
        await getPool().query(
          "SELECT id FROM purchases WHERE tag LIKE 'course-compute:%' AND account_id=$1",
          [f.payer],
        )
      ).rows,
    ).toHaveLength(0);
    await work(f.id, "provision_volume");
    const ready = (await getComputeVolumeById(f.id))!;
    expect(ready.ready_at).toBeInstanceOf(Date);
    expect(courseVolumeBinding(ready).payer_account_id).toBe(f.payer);
    expect(ready.owner_account_id).toBe(f.student);
    expect(
      (
        await getPool().query("SELECT id FROM purchases WHERE account_id=$1", [
          f.student,
        ])
      ).rows,
    ).toHaveLength(0);
  },
);

it("recovers a provider creation reply by inspection without recreating the disk", async () => {
  const f = await fixture();
  await reserveCourseVolume(f.volume);
  await work(f.id, "reconcile_volume");
  expect(ensureProviderComputeVolume).not.toHaveBeenCalled();
  expect((await getComputeVolumeById(f.id))!.ready_at).toBeInstanceOf(Date);
});

it("preserves authoritative funding when an old provider metadata snapshot is written", async () => {
  const f = await fixture();
  const reserved = await reserveCourseVolume(f.volume);
  await updateComputeVolume(f.id, {
    metadata: { ...f.volume.metadata, provider: { size_gb: 10 } },
  });
  expect(courseVolumeBinding((await getComputeVolumeById(f.id))!)).toEqual(
    courseVolumeBinding(reserved),
  );
});

it("reserves growth before resize, replays its operation, and starts incremental metering only after provider confirmation", async () => {
  const f = await fixture();
  await work(f.id, "provision_volume");
  const opts = {
    operation_id: randomUUID(),
    expected_funding_version: f.epoch,
    size_gb: 20,
    rate: { hourly_cost_usd: "0.02", pricing_snapshot: { provider: "gcp" } },
  };
  let volume = await reserveCourseVolumeGrowth(
    (await getComputeVolumeById(f.id))!,
    opts,
  );
  volume = await reserveCourseVolumeGrowth(volume, opts);
  expect(
    (
      await getPool().query(
        "SELECT id FROM compute_funding_reservations WHERE resource_id=$1",
        [f.id],
      )
    ).rows,
  ).toHaveLength(2);
  expect(
    volume.metadata.billing.course_funding.growth[0].started_at,
  ).toBeUndefined();
  (inspectProviderComputeVolume as jest.Mock).mockResolvedValue({
    size_gb: 20,
    users: [],
  });
  await work(f.id, "resize_volume");
  const grown = (await getComputeVolumeById(f.id))!;
  expect(grown.size_gb).toBe(20);
  expect(
    grown.metadata.billing.course_funding.growth[0].started_at,
  ).toBeDefined();
  await expect(
    reserveCourseVolumeGrowth(grown, { ...opts, size_gb: 30 }),
  ).rejects.toThrow(/changed size/);
  expect(publicVolumeFundingStatus(grown)!.source).toEqual({
    kind: "course",
    pool_id: f.source.pool_id,
    grant_id: f.source.grant_id,
  });
  expect(publicVolumeFundingStatus(grown)!.payer_account_id).toBeUndefined();
});

it.each([true, false])(
  "worker resumes committed growth after a lost reply (binding saved: %s) without reserving twice",
  async (bindingSaved) => {
    const f = await fixture();
    await work(f.id, "provision_volume");
    await reserveCourseVolumeGrowth((await getComputeVolumeById(f.id))!, {
      operation_id: randomUUID(),
      expected_funding_version: f.epoch,
      size_gb: 20,
      rate: { hourly_cost_usd: "0.02", pricing_snapshot: { provider: "gcp" } },
    });
    await getPool().query(
      `UPDATE compute_volumes SET desired_size_gb=10,state='ready',
    metadata=jsonb_set(metadata,'{billing,rate}',$2::jsonb) WHERE id=$1`,
      [f.id, JSON.stringify(f.volume.metadata.billing.rate)],
    );
    if (!bindingSaved)
      await getPool().query(
        "UPDATE compute_volumes SET metadata=metadata #- '{billing,course_funding,growth,0,binding}' WHERE id=$1",
        [f.id],
      );
    (inspectProviderComputeVolume as jest.Mock)
      .mockResolvedValueOnce({ size_gb: 10, users: [] })
      .mockResolvedValue({ size_gb: 20, users: [] });
    await work(f.id, "reconcile_volume");
    expect(resizeProviderComputeVolume).toHaveBeenCalledTimes(1);
    expect((await getComputeVolumeById(f.id))!.size_gb).toBe(20);
    expect(
      (
        await getPool().query(
          "SELECT id FROM compute_funding_reservations WHERE resource_id=$1",
          [f.id],
        )
      ).rows,
    ).toHaveLength(2);
  },
);

it("stops an attached VM on revocation, retains the independently funded disk, and denies attach or lane-switch bypasses", async () => {
  const f = await fixture();
  await work(f.id, "provision_volume");
  const vm = randomUUID();
  await getPool().query(
    "INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,home_volume_id,state,desired_state) VALUES ($1,$2,$3,$4,'ready','running')",
    [vm, f.student, getConfiguredBayId(), f.id],
  );
  await updateComputeVolume(f.id, {
    attached_vm_id: vm,
    attachment_state: "attached",
  });
  await getPool().query(
    "UPDATE compute_funding_grants SET state='revoked' WHERE id=$1",
    [f.source.grant_id],
  );
  await enforceCourseVolumeFunding((await getComputeVolumeById(f.id))!);
  const retained = (await getComputeVolumeById(f.id))!;
  expect(retained.deleted_at).toBeNull();
  expect(publicVolumeFundingStatus(retained)!.state).toBe("protected");
  expect(
    (
      await getPool().query(
        "SELECT desired_state FROM compute_vms WHERE id=$1",
        [vm],
      )
    ).rows[0].desired_state,
  ).toBe("stopped");
  expect(() => assertCourseVolumeAttachable(retained)).toThrow(
    /protected storage/,
  );
  await expect(
    work(f.id, "funding_transition", { funding_mode: "account-prepaid" }),
  ).rejects.toThrow(/separately approved/);
  expect(deleteProviderComputeVolume).not.toHaveBeenCalled();
});

it("recovers an existing lost reservation after cancellation without minting another, and finalizes deleted GCP storage without VM egress", async () => {
  const f = await fixture();
  const bound = await reserveCourseVolume(f.volume);
  await getPool().query(
    "UPDATE compute_volumes SET metadata=metadata #- '{billing,course_funding,binding}',desired_state='deleted',deleted_at=NOW() WHERE id=$1",
    [f.id],
  );
  await recoverTerminalCourseVolumeFunding();
  const recovered = await recoverCourseVolumeFunding(
    (await getComputeVolumeById(f.id))!,
  );
  expect(courseVolumeBinding(recovered).reservation_id).toBe(
    courseVolumeBinding(bound).reservation_id,
  );
  const {
    rows: [reservation],
  } = await getPool().query(
    "SELECT state,spent_usd,released_usd FROM compute_funding_reservations WHERE resource_id=$1",
    [f.id],
  );
  expect(reservation.state).toBe("settled");
  expect(Number(reservation.spent_usd)).toBe(0);
  expect(Number(reservation.released_usd)).toBeGreaterThan(0);
  expect(publicVolumeFundingStatus(recovered)).toMatchObject({
    state: "closed",
    committed_usd: "0.0000000000",
    remaining_usd: "0.0000000000",
    protected_storage_usd: "0.0000000000",
  });
  await getPool().query(
    "UPDATE compute_volumes SET metadata=metadata #- '{billing,course_funding,committed_usd}' WHERE id=$1",
    [f.id],
  );
  await recoverTerminalCourseVolumeFunding();
  expect(
    publicVolumeFundingStatus((await getComputeVolumeById(f.id))!)!
      .committed_usd,
  ).toBe("0.0000000000");
});

it("enqueues expiry from local state, refuses uncertain attachment deletion, then detaches a confirmed stopped VM without deleting its boot disk", async () => {
  const f = await fixture();
  await work(f.id, "provision_volume");
  const volume = (await getComputeVolumeById(f.id))!;
  const binding = courseVolumeBinding(volume);
  binding.stop_at = new Date(Date.now() - 1000).toISOString();
  binding.storage_delete_at = new Date(Date.now() - 500).toISOString();
  await getPool().query(
    "UPDATE compute_volumes SET metadata=jsonb_set(metadata,'{billing,course_funding,binding}',$2::jsonb) WHERE id=$1",
    [f.id, JSON.stringify(binding)],
  );
  await enqueueCourseVolumeDeadlines();
  expect((await getComputeVolumeById(f.id))!.desired_state).toBe("deleted");
  const vm = randomUUID();
  await getPool().query(
    "INSERT INTO compute_vms (id,owner_account_id,owning_bay_id,home_volume_id,state,desired_state,stopped_at) VALUES ($1,$2,$3,$4,'stopped','stopped',NOW())",
    [vm, f.student, getConfiguredBayId(), f.id],
  );
  await updateComputeVolume(f.id, {
    attached_vm_id: vm,
    attachment_state: "unknown",
  });
  (inspectProviderComputeVolume as jest.Mock).mockResolvedValueOnce({
    size_gb: 10,
    users: ["foreign-instance"],
  });
  await expect(work(f.id, "delete_volume")).rejects.toThrow(
    /detach is not confirmed/,
  );
  expect(deleteProviderComputeVolume).not.toHaveBeenCalled();
  await work(f.id, "delete_volume");
  expect(detachProviderComputeHomeVolume).toHaveBeenCalled();
  expect(deleteProviderComputeVolume).toHaveBeenCalledTimes(1);
  expect(
    (
      await getPool().query(
        "SELECT home_volume_id,deleted_at FROM compute_vms WHERE id=$1",
        [vm],
      )
    ).rows[0],
  ).toMatchObject({ home_volume_id: null, deleted_at: null });
  expect((await getComputeVolumeById(f.id))!.deleted_at).toBeInstanceOf(Date);
});

it("finds a late growth commitment even after deletion settled the known base reservation", async () => {
  const f = await fixture();
  await work(f.id, "provision_volume");
  await reserveCourseVolumeGrowth((await getComputeVolumeById(f.id))!, {
    operation_id: randomUUID(),
    expected_funding_version: f.epoch,
    size_gb: 20,
    rate: { hourly_cost_usd: "0.02", pricing_snapshot: { provider: "gcp" } },
  });
  await getPool().query(
    `UPDATE compute_volumes SET desired_state='deleted',deleted_at=NOW(),
    metadata=metadata #- '{billing,course_funding,growth,0,binding}' WHERE id=$1`,
    [f.id],
  );
  await meterCourseVolume((await getComputeVolumeById(f.id))!);
  expect((await getComputeVolumeById(f.id))!.billing_state).toBe("closed");
  expect(
    publicVolumeFundingStatus((await getComputeVolumeById(f.id))!),
  ).toMatchObject({
    state: "settling",
    committed_usd: undefined,
  });
  await recoverTerminalCourseVolumeFunding();
  expect(
    (await getComputeVolumeById(f.id))!.metadata.billing.course_funding
      .growth[0].binding,
  ).toBeDefined();
  const { rows } = await getPool().query(
    "SELECT state FROM compute_funding_reservations WHERE resource_id=$1",
    [f.id],
  );
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.state === "settled")).toBe(true);
});

it("cannot stop a freshly renewed volume using a stale deadline snapshot", async () => {
  const f = await fixture();
  const old = await reserveCourseVolume(f.volume);
  const binding = courseVolumeBinding(old);
  await getPool().query(
    "UPDATE compute_volumes SET metadata=jsonb_set(metadata,'{billing,course_funding,binding,authorized_until}',to_jsonb($2::text)) WHERE id=$1",
    [
      f.id,
      new Date(
        new Date(binding.authorized_until).valueOf() + 60_000,
      ).toISOString(),
    ],
  );
  await endCourseVolumeService(old);
  expect(
    (await getComputeVolumeById(f.id))!.metadata.billing.course_funding
      .service_ended_at,
  ).toBeUndefined();
  await expect(
    requireCourseVolumeService({ ...old, owner_account_id: randomUUID() }),
  ).rejects.toThrow(/pending or stale/);
});
