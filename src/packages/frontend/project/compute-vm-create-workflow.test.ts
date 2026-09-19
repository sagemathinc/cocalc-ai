import type { ComputeVolume } from "@cocalc/conat/hub/api/compute";
import {
  createVmWithHomeVolume,
  prepareCourseFundedVmValues,
  vmCreationAttempt,
} from "./compute-vm-create-workflow";
import type { VmCreateCliValues } from "./compute-vms-cli";

const source = {
  kind: "course" as const,
  payer_account_id: "payer",
  pool_id: "pool",
  grant_id: "grant",
};
function harness() {
  const volume = {
    id: "volume-id",
    name: "home",
    state: "ready",
    desired_state: "ready",
    funding_source: source,
    funding_status: {
      source,
      payer_account_id: "payer",
      label: "Course storage",
      state: "running",
      funding_version: "epoch",
      as_of: new Date().toISOString(),
      authorized_until: new Date(Date.now() + 3600000).toISOString(),
    },
  } as ComputeVolume;
  const values: VmCreateCliValues = {
    name: "vm",
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    funding_mode: "account-prepaid",
    funding_source: source,
    region: "us-west1",
    zone: "us-west1-a",
    machine_type: "e2-standard-2",
    pricing_model: "on_demand",
    allow_on_demand_fallback: false,
    boot_disk_gb: 20,
    create_home_volume: true,
    new_home_volume_name: "home",
    new_home_volume_size_gb: 50,
    accept_course_retention: true,
  };
  const api = {
    getCatalog: jest.fn().mockResolvedValue({ sponsored_home_volumes: true }),
    createVolume: jest.fn().mockResolvedValue(volume),
    getVolume: jest.fn().mockResolvedValue(volume),
    createVm: jest.fn().mockResolvedValue({ id: "vm-id" }),
  };
  const onVolumeCreated = jest.fn();
  const run = (extra = {}) =>
    createVmWithHomeVolume({
      api,
      values,
      vmKey: "vm-key",
      volumeKey: "volume-key",
      onVolumeCreated,
      wait: async () => {},
      ...extra,
    });
  return { volume, values, api, onVolumeCreated, run };
}

it("forces managed project access for course-funded VMs and creates a key when needed", async () => {
  const h = harness();
  h.values.allow_on_demand_fallback = true;
  h.values.configure_project_ssh = false;
  const generateProjectSshKey = jest
    .fn()
    .mockResolvedValue(" ssh-ed25519 AAAAPROJECT project ");
  const prepared = await prepareCourseFundedVmValues({
    values: h.values,
    project_id: "project",
    projectSshPublicKey: null,
    generateProjectSshKey,
  });
  expect(prepared.projectSshPublicKey).toBe("ssh-ed25519 AAAAPROJECT project");
  expect(prepared.values).toMatchObject({
    allow_on_demand_fallback: false,
    configure_project_ssh: true,
    ssh_public_key: "ssh-ed25519 AAAAPROJECT project",
  });
  expect(generateProjectSshKey).toHaveBeenCalledTimes(1);
  await expect(
    prepareCourseFundedVmValues({
      values: h.values,
      projectSshPublicKey: null,
      generateProjectSshKey,
    }),
  ).rejects.toThrow("CoCalc project");
});

it("leaves personally funded VM access choices unchanged", async () => {
  const h = harness();
  h.values.funding_source = undefined;
  h.values.allow_on_demand_fallback = true;
  h.values.configure_project_ssh = false;
  const generateProjectSshKey = jest.fn();
  const prepared = await prepareCourseFundedVmValues({
    values: h.values,
    project_id: "project",
    projectSshPublicKey: null,
    generateProjectSshKey,
  });
  expect(prepared.values).toBe(h.values);
  expect(generateProjectSshKey).not.toHaveBeenCalled();
});

it("retains both request identities through a lost VM reply and resets on changed terms", async () => {
  const h = harness();
  const first = vmCreationAttempt(undefined, h.values, "project");
  expect(first.vmKey).not.toBe(first.volumeKey);
  h.api.createVm.mockRejectedValueOnce(Error("reply lost"));
  await expect(h.run(first)).rejects.toThrow("reply lost");
  const retry = vmCreationAttempt(first, { ...h.values }, "project");
  expect(retry).toBe(first);
  await h.run(retry);
  expect(
    h.api.createVm.mock.calls.map(([args]) => args.idempotency_key),
  ).toEqual([first.vmKey, first.vmKey]);
  expect(
    h.api.createVolume.mock.calls.map(([args]) => args.idempotency_key),
  ).toEqual([first.volumeKey, first.volumeKey]);
  expect(
    vmCreationAttempt(first, { ...h.values, name: "different" }, "project")
      .vmKey,
  ).not.toBe(first.vmKey);
  expect(
    vmCreationAttempt(first, h.values, "different-project").vmKey,
  ).not.toBe(first.vmKey);
});

it("connects both creations with explicit payer, independent keys and reviewed attachment", async () => {
  const h = harness();
  h.values.stop_after_minutes = 90;
  await h.run({ project_id: "project", browser_id: "browser" });
  expect(h.api.createVolume).toHaveBeenCalledWith(
    expect.objectContaining({
      funding_source: source,
      accept_course_retention: true,
      idempotency_key: "volume-key",
    }),
  );
  expect(h.api.createVm).toHaveBeenCalledWith(
    expect.objectContaining({
      funding_source: source,
      home_volume: "home",
      expected_home_volume_funding_version: "epoch",
      idempotency_key: "vm-key",
      stop_after_minutes: 90,
      project_id: "project",
      browser_id: "browser",
    }),
  );
});
it("does not create either resource without retention acknowledgment", async () => {
  const h = harness();
  h.values.accept_course_retention = false;
  await expect(h.run()).rejects.toThrow("independent course retention");
  expect(h.api.createVolume).not.toHaveBeenCalled();
  expect(h.api.createVm).not.toHaveBeenCalled();
});
it("unsupported or missing backend capability blocks before any create", async () => {
  for (const catalog of [{ sponsored_home_volumes: false }, {}]) {
    const h = harness();
    h.api.getCatalog.mockResolvedValue(catalog);
    await expect(h.run()).rejects.toThrow("unavailable on this server");
    expect(h.api.createVolume).not.toHaveBeenCalled();
    expect(h.api.createVm).not.toHaveBeenCalled();
  }
});
it("never retries backend volume rejection with personal funding", async () => {
  const h = harness();
  h.api.createVolume.mockRejectedValue(Error("sponsored rollout disabled"));
  await expect(h.run()).rejects.toThrow("rollout disabled");
  expect(h.api.createVolume).toHaveBeenCalledTimes(1);
  expect(h.api.createVm).not.toHaveBeenCalled();
  expect(h.onVolumeCreated).not.toHaveBeenCalled();
});
it("waits for volume readiness and identifies the retained volume before VM failure", async () => {
  const h = harness();
  h.api.createVolume.mockResolvedValue({ ...h.volume, state: "requested" });
  h.api.createVm.mockRejectedValue(Error("VM unavailable"));
  await expect(h.run()).rejects.toThrow("VM unavailable");
  expect(h.onVolumeCreated).toHaveBeenCalledWith(
    expect.objectContaining({ name: "home" }),
  );
  expect(h.api.getVolume).toHaveBeenCalledWith({ id_or_name: "volume-id" });
  expect(h.onVolumeCreated.mock.invocationCallOrder[0]).toBeLessThan(
    h.api.createVm.mock.invocationCallOrder[0],
  );
});
it.each(["failed", "deleted"])(
  "retains and reports %s volume creation without starting a VM",
  async (state) => {
    const h = harness();
    h.api.createVolume.mockResolvedValue({ ...h.volume, state });
    await expect(h.run()).rejects.toThrow("Home volume creation failed");
    expect(h.onVolumeCreated).toHaveBeenCalled();
    expect(h.api.createVm).not.toHaveBeenCalled();
  },
);
it("bounds the provisioning wait and retains the volume", async () => {
  const h = harness();
  h.api.createVolume.mockResolvedValue({ ...h.volume, state: "requested" });
  let clock = 0;
  await expect(
    h.run({
      now: () => {
        clock += 6 * 60_000;
        return clock;
      },
    }),
  ).rejects.toThrow("still provisioning");
  expect(h.onVolumeCreated).toHaveBeenCalled();
  expect(h.api.createVm).not.toHaveBeenCalled();
});
it("a changed or missing volume source cannot silently become personal", async () => {
  for (const funding_source of [
    undefined,
    { ...source, payer_account_id: "other-payer" },
  ]) {
    const h = harness();
    h.api.createVolume.mockResolvedValue({
      ...h.volume,
      funding_source,
      funding_status: undefined,
    });
    await expect(h.run()).rejects.toThrow("does not match");
    expect(h.api.createVm).not.toHaveBeenCalled();
  }
});
it("unknown funding blocks attaching a successfully created volume", async () => {
  const h = harness();
  h.api.createVolume.mockResolvedValue({
    ...h.volume,
    funding_status: undefined,
  });
  await expect(h.run()).rejects.toThrow("funding is unavailable");
  expect(h.onVolumeCreated).toHaveBeenCalled();
  expect(h.api.createVm).not.toHaveBeenCalled();
});
it("a personal VM retains its attached volume's independent course payer", async () => {
  const h = harness();
  Object.assign(h.values, {
    funding_source: undefined,
    create_home_volume: false,
    home_volume: "home",
    expected_home_volume_funding_version: "epoch",
  });
  await h.run();
  expect(h.api.createVolume).not.toHaveBeenCalled();
  expect(h.api.createVm).toHaveBeenCalledWith(
    expect.objectContaining({
      funding_source: undefined,
      home_volume: "home",
      expected_home_volume_funding_version: "epoch",
    }),
  );
});
it("attachment epoch changes invalidate the user's review", async () => {
  const h = harness();
  Object.assign(h.values, {
    create_home_volume: false,
    home_volume: "home",
    expected_home_volume_funding_version: "old-epoch",
  });
  await expect(h.run()).rejects.toThrow("Review its payer and retention again");
  expect(h.api.createVm).not.toHaveBeenCalled();
});
it("legacy VM and personal home-volume creation stay compatible", async () => {
  const h = harness();
  h.values.funding_source = undefined;
  h.api.createVolume.mockResolvedValue({
    ...h.volume,
    funding_source: undefined,
    funding_status: undefined,
  });
  await h.run();
  expect(h.api.getCatalog).not.toHaveBeenCalled();
  expect(h.api.createVm).toHaveBeenCalledWith(
    expect.objectContaining({
      funding_source: undefined,
      expected_home_volume_funding_version: undefined,
      stop_after_minutes: 360,
    }),
  );
});
