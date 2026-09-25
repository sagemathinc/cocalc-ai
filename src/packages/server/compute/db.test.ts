/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { after, before, getPool } from "@cocalc/server/test";
import {
  addComputeVmSshPublicKey,
  allocateComputeVmPublicHostname,
  claimComputeWork,
  enqueueComputeWork,
  enqueueComputeEmergencyStops,
  enqueueExpiredComputeVms,
  enqueueComputeReconciliation,
  finishComputeWork,
  heartbeatComputeWork,
  insertComputeInstance,
  insertComputeVm,
  getComputeVmById,
  listComputeVmsForBillingEnforcement,
  listComputeVmsForEgressMetering,
  listComputeVmsForInventory,
  listCurrentComputeInstanceTimings,
  listOwnedComputeVms,
  listProjectComputeVms,
  removeComputeVmSshPublicKey,
  resolveProjectComputeVm,
  updateComputeVmEgressMetadata,
  updateComputeVmProviderObservation,
  updateComputeInstance,
  updateComputeVm,
} from "./db";
import type { ComputeVmRow } from "./types";
import type { ComputeVolumeRow } from "./types";
import {
  getComputeVolumeById,
  insertComputeVolume,
  enqueueComputeVolumeReconciliation,
  listComputeVolumesForInventory,
  listOwnedComputeVolumes,
  updateComputeVolume,
} from "./volume-db";
import {
  ComputeWorkLeaseLostError,
  markCurrentComputeWorkLeaseCompleted,
  runWithComputeWorkLease,
} from "./work-lease";
import {
  activeComputeVmProjectKeys,
  grantComputeVmProjectAccess,
  listComputeVmProjectAccess,
  revokeComputeVmProjectAccess,
} from "./project-access";
import { backfillComputeVmProjectAccess } from "@cocalc/database/postgres/schema/compute-vm-project-access";

const postgresIt = process.env.COCALC_TEST_USE_PGLITE ? it.skip : it;

beforeAll(async () => await before({ noConat: true }), 15_000);
afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM compute_resource_work");
  await getPool().query("DELETE FROM compute_resource_events");
  await getPool().query("DELETE FROM compute_vm_instances");
  await getPool().query("DELETE FROM compute_vm_project_access");
  await getPool().query("DELETE FROM compute_vms");
  await getPool().query("DELETE FROM compute_volumes");
});

function vmInput(
  overrides: Partial<ComputeVmRow> = {},
): Parameters<typeof insertComputeVm>[0] {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    name: overrides.name ?? "test-vm",
    owner_account_id: overrides.owner_account_id ?? randomUUID(),
    owning_bay_id: "bay-0",
    project_id: Object.prototype.hasOwnProperty.call(overrides, "project_id")
      ? overrides.project_id
      : randomUUID(),
    provider: overrides.provider ?? "gcp",
    operating_system: overrides.operating_system ?? "linux",
    operating_system_version:
      overrides.operating_system_version ?? "ubuntu-24.04",
    os_license_hourly_price: overrides.os_license_hourly_price ?? "0.000000",
    region: overrides.region ?? "us-central1",
    zone: Object.prototype.hasOwnProperty.call(overrides, "zone")
      ? overrides.zone
      : "us-central1-a",
    architecture: "x86_64",
    machine_type: overrides.machine_type ?? "e2-standard-2",
    cpu: 2,
    ram_gb: 8,
    gpu_type: null,
    gpu_count: 0,
    provider_spec: {},
    funding_mode: "account-prepaid",
    desired_pricing_model: "on_demand",
    effective_pricing_model: "on_demand",
    boot_disk_gb: 20,
    boot_disk_id: `cocalc-vm-${id.slice(0, 8)}-boot`,
    home_volume_id: overrides.home_volume_id ?? null,
    state: "requested",
    desired_state: "running",
    instance_generation: 1,
    provider_instance_id: `cocalc-vm-${id.slice(0, 8)}`,
    public_address_id: null,
    public_address_state: "released",
    public_ip: null,
    public_hostname:
      overrides.public_hostname ??
      `vm-${id.replaceAll("-", "").slice(0, 32)}.example.test`,
    dns_record_id: null,
    dns_state: "released",
    dns_error: null,
    public_ports: [22, 443],
    ssh_user: "user",
    ssh_public_key: overrides.ssh_public_key ?? "ssh-ed25519 AAAATEST owner",
    expires_at: Object.prototype.hasOwnProperty.call(overrides, "expires_at")
      ? overrides.expires_at
      : new Date(Date.now() + 60_000),
    bootstrap_revision: 1,
    observed_bootstrap_revision: null,
    public_port_policy_revision: 1,
    allow_on_demand_fallback: false,
    authorized_fallback_hours: 0,
    spot_hourly_price: "0.020000",
    on_demand_hourly_price: "0.068000",
    authorized_cost: "1.000000",
    accrued_cost: "0.000000",
    billing_state: "staging_admin_unbilled",
    spot_recovery_policy: {},
    spot_recovery_state: {},
    idempotency_key: overrides.idempotency_key ?? randomUUID(),
    error: null,
    metadata: overrides.metadata ?? {},
  };
}

function volumeInput(
  overrides: Partial<ComputeVolumeRow> = {},
): Parameters<typeof insertComputeVolume>[0] {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    name: overrides.name ?? "test-volume",
    owner_account_id: overrides.owner_account_id ?? randomUUID(),
    owning_bay_id: "bay-0",
    provider: overrides.provider ?? "gcp",
    region: overrides.region ?? "us-central1",
    zone: Object.prototype.hasOwnProperty.call(overrides, "zone")
      ? overrides.zone
      : "us-central1-a",
    role: "home",
    funding_mode: "account-prepaid",
    provider_spec: {},
    disk_type: overrides.disk_type ?? "balanced",
    filesystem: "ext4",
    size_gb: overrides.size_gb ?? 20,
    desired_size_gb: overrides.desired_size_gb ?? 20,
    effective_size_gb: overrides.effective_size_gb ?? 20,
    provider_disk_id: `cocalc-vol-${id.slice(0, 8)}`,
    state: overrides.state ?? "ready",
    desired_state: "ready",
    attached_vm_id: overrides.attached_vm_id ?? null,
    attachment_generation: 0,
    attachment_state: overrides.attachment_state ?? "detached",
    monthly_price_per_gb: "0.100000",
    authorized_monthly_cost: "2.000000",
    billing_state: "staging_admin_unbilled",
    idempotency_key: overrides.idempotency_key ?? randomUUID(),
    error: null,
    metadata: {},
  };
}

describe("compute VM durable state", () => {
  it("persists a scheduled stop separately from deletion and does not refresh it on create retry", async () => {
    const input = {
      ...vmInput(),
      stop_after_minutes: 360,
      stop_at: new Date(Date.now() + 360 * 60000),
      stop_generation: 1,
      expires_at: null,
    };
    const created = await insertComputeVm(input);
    expect(created.stop_after_minutes).toBe(360);
    expect(created.stop_at).toEqual(input.stop_at);
    expect(created.expires_at).toBeNull();
    const retry = await insertComputeVm({
      ...input,
      stop_at: new Date(Date.now() + 720 * 60000),
    });
    expect(retry.stop_at).toEqual(created.stop_at);
    expect(retry.stop_generation).toBe(1);
  });
  it("records provider interruptions on the active instance generation", async () => {
    const vm = await insertComputeVm(vmInput());
    await insertComputeInstance(vm);

    await updateComputeInstance(vm, {
      preempted: true,
      terminal_reason: "provider_spot_interruption",
    });

    const { rows } = await getPool().query(
      `SELECT preempted_at IS NOT NULL AS preempted, terminal_reason
       FROM compute_vm_instances
       WHERE vm_id=$1 AND generation=$2`,
      [vm.id, vm.instance_generation],
    );
    expect(rows).toEqual([
      {
        preempted: true,
        terminal_reason: "provider_spot_interruption",
      },
    ]);
  });

  it("returns lifecycle timing only for the current instance generation", async () => {
    const first = await insertComputeVm(vmInput());
    await insertComputeInstance(first);
    await updateComputeInstance(first, { running: true, ready: true });

    const second = (await updateComputeVm(first.id, {
      instance_generation: first.instance_generation + 1,
      state: "provisioning",
    }))!;
    await insertComputeInstance(second);

    const timings = await listCurrentComputeInstanceTimings([first.id]);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({
      vm_id: first.id,
      generation: second.instance_generation,
      running_at: null,
      ready_at: null,
    });
    expect(timings[0]?.created_at).toBeInstanceOf(Date);
  });

  it("resolves only active project access grants", async () => {
    const owner = randomUUID();
    const project = randomUUID();
    const vm = await insertComputeVm(
      vmInput({ owner_account_id: owner, project_id: null }),
    );
    const key = "ssh-ed25519 AAAAPROJECT project";

    await grantComputeVmProjectAccess({
      owner_account_id: owner,
      vm_id: vm.id,
      project_id: project,
      ssh_public_key: key,
      created_by_account_id: owner,
    });

    await expect(
      resolveProjectComputeVm({ project_id: project, id_or_name: vm.id }),
    ).resolves.toMatchObject({ id: vm.id });
    await expect(
      listProjectComputeVms({ project_id: project }),
    ).resolves.toEqual([expect.objectContaining({ id: vm.id })]);
    await expect(activeComputeVmProjectKeys(vm.id)).resolves.toEqual([key]);

    const revoked = await revokeComputeVmProjectAccess({
      owner_account_id: owner,
      vm_id: vm.id,
      project_id: project,
    });
    await expect(
      revokeComputeVmProjectAccess({
        owner_account_id: owner,
        vm_id: vm.id,
        project_id: project,
      }),
    ).resolves.toMatchObject({
      revoked_at: revoked.revoked_at,
      state: "revoking",
    });

    await expect(
      resolveProjectComputeVm({ project_id: project, id_or_name: vm.id }),
    ).resolves.toBeUndefined();
    await expect(
      listProjectComputeVms({ project_id: project }),
    ).resolves.toEqual([]);
    await expect(activeComputeVmProjectKeys(vm.id)).resolves.toEqual([]);
    await expect(
      listComputeVmProjectAccess({ owner_account_id: owner }),
    ).resolves.toEqual([
      expect.objectContaining({
        vm_id: vm.id,
        project_id: project,
        state: "revoking",
      }),
    ]);
  });

  it("moves a legacy project deploy key into the revocable grant", async () => {
    const owner = randomUUID();
    const project = randomUUID();
    const key = "ssh-ed25519 AAAALEGACY project";
    const vm = await insertComputeVm(
      vmInput({
        owner_account_id: owner,
        project_id: project,
        ssh_public_key: key,
        metadata: { configure_project_ssh: true },
      }),
    );

    await backfillComputeVmProjectAccess(getPool());

    await expect(getComputeVmById(vm.id)).resolves.toMatchObject({
      ssh_public_key: "",
    });
    await expect(listComputeVmProjectAccess({ vm_id: vm.id })).resolves.toEqual(
      [
        expect.objectContaining({
          project_id: project,
          ssh_public_key: key,
        }),
      ],
    );
  });

  it("quarantines pre-v2 rows while retaining them for provider inventory", async () => {
    const vm = await insertComputeVm(vmInput());
    const volume = await insertComputeVolume(
      volumeInput({
        owner_account_id: vm.owner_account_id,
        project_id: vm.project_id,
        attached_vm_id: vm.id,
      }),
      10,
    );
    await getPool().query(
      `UPDATE compute_vms
       SET public_hostname=NULL, bootstrap_revision=NULL, funding_mode=NULL,
           expires_at=NOW() - interval '1 minute'
       WHERE id=$1`,
      [vm.id],
    );
    await getPool().query(
      `UPDATE compute_volumes SET role=NULL, funding_mode=NULL WHERE id=$1`,
      [volume.id],
    );

    await expect(
      listOwnedComputeVms({ owner_account_id: vm.owner_account_id }),
    ).resolves.toEqual([]);
    await expect(
      listOwnedComputeVolumes({ owner_account_id: vm.owner_account_id }),
    ).resolves.toEqual([]);
    await expect(listComputeVmsForBillingEnforcement()).resolves.toEqual([]);
    await expect(listComputeVmsForEgressMetering()).resolves.toEqual([]);
    await expect(enqueueExpiredComputeVms()).resolves.toBe(0);
    await expect(enqueueComputeEmergencyStops()).resolves.toBe(0);
    await expect(enqueueComputeReconciliation()).resolves.toBe(0);
    await expect(enqueueComputeVolumeReconciliation()).resolves.toBe(0);

    await expect(listComputeVmsForInventory()).resolves.toEqual([
      expect.objectContaining({ id: vm.id }),
    ]);
    await expect(listComputeVolumesForInventory()).resolves.toEqual([
      expect.objectContaining({ id: volume.id }),
    ]);
  });

  it("allocates a random hostname and retries a collision", async () => {
    const labels = [
      "vm-11111111111111111111111111111111",
      "vm-22222222222222222222222222222222",
    ];
    await insertComputeVm(
      vmInput({
        public_hostname: `${labels[0]}.staging.example.com`,
      }),
    );

    await expect(
      allocateComputeVmPublicHostname(
        "https://staging.example.com/",
        () => labels.shift()!,
      ),
    ).resolves.toBe("vm-22222222222222222222222222222222.staging.example.com");
  });

  it("deduplicates owner-scoped create idempotency", async () => {
    const input = vmInput();
    const first = await insertComputeVm(input);
    const second = await insertComputeVm({
      ...input,
      id: randomUUID(),
      provider_instance_id: "must-not-be-inserted",
    });
    expect(second.id).toBe(first.id);
    expect(
      await listOwnedComputeVms({ owner_account_id: input.owner_account_id }),
    ).toHaveLength(1);
  });

  it("attaches a zoneless Nebius volume to a zoneless VM", async () => {
    const owner = randomUUID();
    const project = randomUUID();
    const volume = await insertComputeVolume(
      volumeInput({
        owner_account_id: owner,
        project_id: project,
        provider: "nebius",
        region: "us-central1",
        zone: null,
        disk_type: "ssd",
      }),
    );
    const vm = await insertComputeVm(
      vmInput({
        owner_account_id: owner,
        project_id: project,
        provider: "nebius",
        region: "us-central1",
        zone: undefined,
        machine_type: "1gpu-24vcpu-218gb",
        home_volume_id: volume.id,
      }),
    );
    expect(vm.home_volume_id).toBe(volume.id);
    await expect(getComputeVolumeById(volume.id)).resolves.toMatchObject({
      attached_vm_id: vm.id,
      attachment_state: "reserved",
    });
  });

  it("reserves a newly provisioning volume before it becomes ready", async () => {
    const owner = randomUUID();
    const project = randomUUID();
    const volume = await insertComputeVolume(
      volumeInput({
        owner_account_id: owner,
        project_id: project,
        state: "requested",
      }),
      2,
    );

    const vm = await insertComputeVm(
      vmInput({
        owner_account_id: owner,
        project_id: project,
        home_volume_id: volume.id,
      }),
    );

    expect(vm.home_volume_id).toBe(volume.id);
    await expect(getComputeVolumeById(volume.id)).resolves.toMatchObject({
      state: "requested",
      attached_vm_id: vm.id,
      attachment_state: "reserved",
    });
  });

  it("resolves only an unambiguous VM attached to the project", async () => {
    const project = randomUUID();
    const first = await insertComputeVm(
      vmInput({ project_id: project, name: "shared-name" }),
    );
    expect(
      (
        await resolveProjectComputeVm({
          project_id: project,
          id_or_name: first.id,
        })
      )?.id,
    ).toBe(first.id);
    await insertComputeVm(
      vmInput({ project_id: project, name: "shared-name" }),
    );
    await expect(
      resolveProjectComputeVm({
        project_id: project,
        id_or_name: "shared-name",
      }),
    ).rejects.toThrow("ambiguous");
  });

  it("enforces the account admission limit across project grants", async () => {
    const owner = randomUUID();
    const project = randomUUID();
    await insertComputeVm(
      vmInput({ owner_account_id: owner, project_id: project }),
      {
        max_active_per_account: 1,
        max_active_total: 10,
      },
    );
    await expect(
      insertComputeVm(
        vmInput({
          owner_account_id: owner,
          project_id: project,
          name: "second-vm",
        }),
        {
          max_active_per_account: 1,
          max_active_total: 10,
        },
      ),
    ).rejects.toThrow("account limit reached");
    await expect(
      insertComputeVm(
        vmInput({ owner_account_id: owner, name: "other-project" }),
        {
          max_active_per_account: 1,
          max_active_total: 10,
        },
      ),
    ).rejects.toThrow("account limit reached");
  });

  it("adds SSH public keys idempotently", async () => {
    const input = vmInput();
    const vm = await insertComputeVm(input);
    const first = await addComputeVmSshPublicKey({
      id: vm.id,
      owner_account_id: input.owner_account_id,
      ssh_public_key: "ssh-ed25519 AAAASECOND second",
    });
    const duplicate = await addComputeVmSshPublicKey({
      id: vm.id,
      owner_account_id: input.owner_account_id,
      ssh_public_key: "ssh-ed25519 AAAASECOND second",
    });
    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    expect(duplicate.vm.metadata.ssh_public_keys).toEqual([
      "ssh-ed25519 AAAATEST owner",
      "ssh-ed25519 AAAASECOND second",
    ]);
  });

  it("removes direct SSH public keys without changing project keys", async () => {
    const input = vmInput({
      metadata: {
        ssh_public_keys: [
          "ssh-ed25519 AAAATEST owner",
          "ssh-ed25519 AAAASECOND second",
        ],
        project_ssh_public_keys: ["ssh-ed25519 AAAAPROJECT project"],
      },
    });
    const vm = await insertComputeVm(input);
    const removed = await removeComputeVmSshPublicKey({
      id: vm.id,
      owner_account_id: input.owner_account_id,
      ssh_public_key: "ssh-ed25519 AAAATEST owner",
    });
    const duplicate = await removeComputeVmSshPublicKey({
      id: vm.id,
      owner_account_id: input.owner_account_id,
      ssh_public_key: "ssh-ed25519 AAAATEST owner",
    });

    expect(removed.removed).toBe(true);
    expect(removed.vm.ssh_public_key).toBe("ssh-ed25519 AAAASECOND second");
    expect(removed.vm.metadata.ssh_public_keys).toEqual([
      "ssh-ed25519 AAAASECOND second",
    ]);
    expect(removed.vm.metadata.project_ssh_public_keys).toEqual([
      "ssh-ed25519 AAAAPROJECT project",
    ]);
    expect(duplicate.removed).toBe(false);
  });

  it("limits SSH public key metadata growth", async () => {
    const input = vmInput({
      metadata: {
        ssh_public_keys: Array.from(
          { length: 32 },
          (_, index) => "ssh-ed25519 AAAA" + index,
        ),
      },
    });
    const vm = await insertComputeVm(input);
    await expect(
      addComputeVmSshPublicKey({
        id: vm.id,
        owner_account_id: input.owner_account_id,
        ssh_public_key: "ssh-ed25519 AAAANEW new",
      }),
    ).rejects.toThrow("SSH key limit reached (32)");
  });

  postgresIt("serializes concurrent SSH public key additions", async () => {
    const input = vmInput();
    const vm = await insertComputeVm(input);
    await Promise.all([
      addComputeVmSshPublicKey({
        id: vm.id,
        owner_account_id: input.owner_account_id,
        ssh_public_key: "ssh-ed25519 AAAAA first",
      }),
      addComputeVmSshPublicKey({
        id: vm.id,
        owner_account_id: input.owner_account_id,
        ssh_public_key: "ssh-ed25519 AAAAB second",
      }),
    ]);
    const updated = await getComputeVmById(vm.id);
    expect(new Set(updated?.metadata.ssh_public_keys)).toEqual(
      new Set([
        "ssh-ed25519 AAAATEST owner",
        "ssh-ed25519 AAAAA first",
        "ssh-ed25519 AAAAB second",
      ]),
    );
  });

  postgresIt("serializes concurrent site-wide admission", async () => {
    const limits = { max_active_per_account: 10, max_active_total: 1 };
    const results = await Promise.allSettled([
      insertComputeVm(vmInput({ name: "first-vm" }), limits),
      insertComputeVm(vmInput({ name: "second-vm" }), limits),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await getPool().query(
        "SELECT id FROM compute_vms WHERE deleted_at IS NULL",
      ),
    ).toHaveProperty("rowCount", 1);
  });

  it("deduplicates active work and claims it with a worker lease", async () => {
    const vm = await insertComputeVm(vmInput());
    const first = await enqueueComputeWork({
      resource_id: vm.id,
      action: "provision",
      idempotency_key: "provision-1",
    });
    const duplicate = await enqueueComputeWork({
      resource_id: vm.id,
      action: "provision",
      idempotency_key: "provision-2",
    });
    expect(first).toBeTruthy();
    expect(duplicate).toBeUndefined();
    const claimed = await claimComputeWork({ worker_id: "worker-a", limit: 2 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      resource_id: vm.id,
      action: "provision",
      state: "queued",
    });
  });

  it("heartbeats long-running work leases", async () => {
    const vm = await insertComputeVm(vmInput());
    await enqueueComputeWork({
      resource_id: vm.id,
      action: "provision",
      idempotency_key: "provision-heartbeat",
    });
    const [claimed] = await claimComputeWork({
      worker_id: "worker-heartbeat",
      limit: 1,
    });
    await getPool().query(
      "UPDATE compute_resource_work SET locked_at=NOW() - interval '20 minutes' WHERE id=$1",
      [claimed.id],
    );

    await heartbeatComputeWork({
      id: claimed.id,
      worker_id: "worker-heartbeat",
      attempt: claimed.attempt,
    });

    const { rows } = await getPool().query(
      "SELECT locked_at > NOW() - interval '1 minute' AS fresh FROM compute_resource_work WHERE id=$1",
      [claimed.id],
    );
    expect(rows[0]).toEqual({ fresh: true });
  });

  it("serializes different actions for one VM across workers", async () => {
    const firstVm = await insertComputeVm(vmInput({ name: "first-vm" }));
    const secondVm = await insertComputeVm(vmInput({ name: "second-vm" }));
    await enqueueComputeWork({
      resource_id: firstVm.id,
      action: "reconcile",
      idempotency_key: "first-reconcile",
    });
    await enqueueComputeWork({
      resource_id: firstVm.id,
      action: "stop",
      idempotency_key: "first-stop",
    });
    await enqueueComputeWork({
      resource_id: secondVm.id,
      action: "provision",
      idempotency_key: "second-provision",
    });

    const firstClaim = await claimComputeWork({
      worker_id: "worker-a",
      limit: 3,
    });
    expect(firstClaim).toHaveLength(2);
    expect(new Set(firstClaim.map(({ resource_id }) => resource_id))).toEqual(
      new Set([firstVm.id, secondVm.id]),
    );
    expect(await claimComputeWork({ worker_id: "worker-b", limit: 3 })).toEqual(
      [],
    );

    const claimedFirstVm = firstClaim.find(
      ({ resource_id }) => resource_id === firstVm.id,
    )!;
    await finishComputeWork({
      id: claimedFirstVm.id,
      worker_id: "worker-a",
      attempt: claimedFirstVm.attempt,
      state: "done",
    });
    const nextClaim = await claimComputeWork({
      worker_id: "worker-b",
      limit: 3,
    });
    expect(nextClaim).toHaveLength(1);
    expect(nextClaim[0]).toMatchObject({
      resource_id: firstVm.id,
      action: "stop",
    });
  });

  it("rejects completion from a worker whose lease was reclaimed", async () => {
    const vm = await insertComputeVm(vmInput());
    await enqueueComputeWork({
      resource_id: vm.id,
      action: "provision",
      idempotency_key: "provision-reclaimed",
    });
    const [stale] = await claimComputeWork({
      worker_id: "worker-stale",
      limit: 1,
    });
    await getPool().query(
      "UPDATE compute_resource_work SET locked_at=NOW() - interval '20 minutes' WHERE id=$1",
      [stale.id],
    );
    const [current] = await claimComputeWork({
      worker_id: "worker-current",
      limit: 1,
    });

    expect(
      await finishComputeWork({
        id: stale.id,
        worker_id: "worker-stale",
        attempt: stale.attempt,
        state: "done",
      }),
    ).toBe(false);
    const { rows } = await getPool().query(
      "SELECT state,locked_by,attempt FROM compute_resource_work WHERE id=$1",
      [stale.id],
    );
    expect(rows[0]).toEqual({
      state: "in_progress",
      locked_by: "worker-current",
      attempt: current.attempt,
    });
  });

  it.each([
    ["vm", "reconcile"],
    ["volume", "reconcile_volume"],
  ] as const)(
    "fences stale %s resource writes after lease reclamation",
    async (resourceKind, action) => {
      const resource =
        resourceKind === "vm"
          ? await insertComputeVm(vmInput())
          : await insertComputeVolume(volumeInput(), 2);
      await enqueueComputeWork({
        resource_kind: resourceKind,
        resource_id: resource.id,
        action,
        idempotency_key: `fence-${resourceKind}`,
      });
      const [stale] = await claimComputeWork({
        worker_id: "worker-stale",
        limit: 1,
      });
      await runWithComputeWorkLease(
        {
          id: stale.id,
          worker_id: "worker-stale",
          attempt: stale.attempt,
        },
        async () => {
          await getPool().query(
            "UPDATE compute_resource_work SET locked_at=NOW() - interval '20 minutes' WHERE id=$1",
            [stale.id],
          );
          const [current] = await claimComputeWork({
            worker_id: "worker-current",
            limit: 1,
          });
          expect(current.attempt).toBeGreaterThan(stale.attempt);
          const update =
            resourceKind === "vm"
              ? updateComputeVm(resource.id, { state: "failed" })
              : updateComputeVolume(resource.id, { state: "failed" });
          await expect(update).rejects.toBeInstanceOf(
            ComputeWorkLeaseLostError,
          );
        },
      );
      const currentResource =
        resourceKind === "vm"
          ? await getComputeVmById(resource.id)
          : await getComputeVolumeById(resource.id);
      expect(currentResource?.state).toBe(resource.state);
    },
  );

  it("never permits resource writes after a work generation is completed", async () => {
    const vm = await insertComputeVm(vmInput());
    await runWithComputeWorkLease(
      { id: randomUUID(), worker_id: "worker-complete", attempt: 1 },
      async () => {
        markCurrentComputeWorkLeaseCompleted();
        await expect(
          updateComputeVm(vm.id, { state: "failed" }),
        ).rejects.toBeInstanceOf(ComputeWorkLeaseLostError);
      },
    );
    expect((await getComputeVmById(vm.id))?.state).toBe(vm.state);
  });

  it("turns an expired lease into durable delete work", async () => {
    const vm = await insertComputeVm(
      vmInput({ expires_at: new Date(Date.now() - 60_000) }),
    );
    expect(await enqueueExpiredComputeVms()).toBe(1);
    const current = await getPool().query(
      "SELECT state, desired_state FROM compute_vms WHERE id=$1",
      [vm.id],
    );
    expect(current.rows[0]).toEqual({
      state: "deleting",
      desired_state: "deleted",
    });
    const work = await getPool().query(
      "SELECT action, state FROM compute_resource_work WHERE resource_id=$1",
      [vm.id],
    );
    expect(work.rows).toEqual([{ action: "delete", state: "queued" }]);
  });

  it("updates egress without replacing concurrent billing metadata", async () => {
    const vm = await insertComputeVm(
      vmInput({
        metadata: {
          billing: {
            funding_mode: "site-funded",
            pending_funding_mode: "account-prepaid",
          },
          runtime: { provider_status: "RUNNING" },
        },
      }),
    );

    const updated = await updateComputeVmEgressMetadata(vm.id, {
      metered_through_at: "2026-08-13T02:30:00.000Z",
      total_bytes: 1234,
      total_cost_usd: "0.000000123",
      error: null,
    });

    expect(updated?.metadata).toEqual({
      billing: {
        funding_mode: "site-funded",
        pending_funding_mode: "account-prepaid",
        egress: {
          metered_through_at: "2026-08-13T02:30:00.000Z",
          total_bytes: 1234,
          total_cost_usd: "0.000000123",
          error: null,
        },
      },
      runtime: { provider_status: "RUNNING" },
    });
  });

  it("retains the last cloud state when a later provider check fails", async () => {
    const vm = await insertComputeVm(
      vmInput({
        metadata: {
          runtime: { provider_status: "RUNNING" },
          provider_observation: {
            state: "running",
            observed_at: "2026-08-20T04:00:00.000Z",
            checked_at: "2026-08-20T04:00:00.000Z",
            error: null,
          },
        },
      }),
    );

    const updated = await updateComputeVmProviderObservation(vm.id, {
      checked_at: "2026-08-20T04:01:00.000Z",
      error: "provider API timeout",
    });

    expect(updated?.metadata).toEqual({
      runtime: { provider_status: "RUNNING" },
      provider_observation: {
        state: "running",
        observed_at: "2026-08-20T04:00:00.000Z",
        checked_at: "2026-08-20T04:01:00.000Z",
        error: "provider API timeout",
      },
    });
  });

  it("keeps budget-only VMs out of expiry while reconciling them", async () => {
    const vm = await insertComputeVm(vmInput({ expires_at: null }));
    expect(vm.expires_at).toBeNull();
    expect(await enqueueExpiredComputeVms()).toBe(0);
    expect(await enqueueComputeReconciliation()).toBe(1);
    const work = await getPool().query(
      "SELECT action, state FROM compute_resource_work WHERE resource_id=$1",
      [vm.id],
    );
    expect(work.rows).toEqual([{ action: "reconcile", state: "queued" }]);
  });

  it("does not continuously reconcile intentionally stopped Nebius VMs", async () => {
    const vm = await insertComputeVm(vmInput({ provider: "nebius" }));
    await getPool().query(
      "UPDATE compute_vms SET state='stopped', desired_state='stopped' WHERE id=$1",
      [vm.id],
    );
    expect(await enqueueComputeReconciliation()).toBe(0);
    const work = await getPool().query(
      "SELECT action, state FROM compute_resource_work WHERE resource_id=$1",
      [vm.id],
    );
    expect(work.rows).toEqual([]);
  });

  it("turns running leases into durable emergency-stop reconciliation", async () => {
    const vm = await insertComputeVm(vmInput());
    expect(await enqueueComputeEmergencyStops()).toBe(1);
    const current = await getPool().query(
      "SELECT desired_state, error FROM compute_vms WHERE id=$1",
      [vm.id],
    );
    expect(current.rows[0]).toEqual({
      desired_state: "stopped",
      error: "site-wide emergency stop requested",
    });
    const work = await getPool().query(
      "SELECT action, state FROM compute_resource_work WHERE resource_id=$1",
      [vm.id],
    );
    expect(work.rows).toEqual([{ action: "reconcile", state: "queued" }]);
  });
});

describe("compute volume durable state", () => {
  it("deduplicates volume creation and enforces the account limit", async () => {
    const input = volumeInput();
    const first = await insertComputeVolume(input, 1);
    const duplicate = await insertComputeVolume(
      { ...input, id: randomUUID(), provider_disk_id: "must-not-exist" },
      1,
    );
    expect(duplicate.id).toBe(first.id);
    await expect(
      insertComputeVolume(
        volumeInput({
          owner_account_id: input.owner_account_id,
          name: "second-volume",
        }),
        1,
      ),
    ).rejects.toThrow("volume account limit reached");
    expect(
      await listOwnedComputeVolumes({
        owner_account_id: input.owner_account_id,
      }),
    ).toHaveLength(1);
  });

  it("atomically fences a volume to one VM", async () => {
    const owner = randomUUID();
    const volume = await insertComputeVolume(
      volumeInput({ owner_account_id: owner }),
      2,
    );
    const first = await insertComputeVm(
      vmInput({
        owner_account_id: owner,
        name: "first-vm",
        home_volume_id: volume.id,
      }),
    );
    await expect(
      insertComputeVm(
        vmInput({
          owner_account_id: owner,
          name: "second-vm",
          home_volume_id: volume.id,
        }),
      ),
    ).rejects.toThrow("already reserved");
    expect(await getComputeVolumeById(volume.id)).toMatchObject({
      attached_vm_id: first.id,
      attachment_state: "reserved",
      attachment_generation: 1,
    });
    expect(await listOwnedComputeVms({ owner_account_id: owner })).toHaveLength(
      1,
    );
  });

  it("keeps volume work distinct in the durable queue", async () => {
    const volume = await insertComputeVolume(volumeInput(), 2);
    await enqueueComputeWork({
      resource_kind: "volume",
      resource_id: volume.id,
      action: "provision_volume",
      idempotency_key: "provision-volume",
    });
    const [work] = await claimComputeWork({
      worker_id: "volume-worker",
      limit: 1,
    });
    expect(work).toMatchObject({
      resource_kind: "volume",
      resource_id: volume.id,
      action: "provision_volume",
    });
  });
});
