import type { ComputeVolume } from "@cocalc/conat/hub/api/compute";
import { createVmWithHomeVolume } from "./compute-vm-create-workflow";
import type { VmCreateCliValues } from "./compute-vms-cli";

const selected = {
  kind: "course" as const,
  payer_account_id: "payer",
  pool_id: "pool",
  grant_id: "grant",
};
function harness() {
  const source = {
    kind: selected.kind,
    pool_id: selected.pool_id,
    grant_id: selected.grant_id,
  };
  const volume = {
    id: "volume",
    name: "home",
    state: "ready",
    desired_state: "ready",
    funding_source: source,
    funding_status: {
      source,
      label: "Course funding",
      state: "ready",
      funding_version: "epoch",
      as_of: new Date().toISOString(),
      authorized_until: new Date(Date.now() + 7200000).toISOString(),
      stop_at: new Date(Date.now() + 3600000).toISOString(),
    },
  } as ComputeVolume;
  const values: VmCreateCliValues = {
    name: "vm",
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    funding_mode: "account-prepaid",
    funding_source: selected,
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
    createVm: jest.fn().mockResolvedValue({ id: "vm" }),
  };
  return {
    volume,
    values,
    api,
    run: () =>
      createVmWithHomeVolume({
        api,
        values,
        vmKey: "vm-key",
        volumeKey: "volume-key",
        onVolumeCreated: jest.fn(),
      }),
  };
}
it("accepts publicVolume's redacted source while preserving the explicit create payer and epoch", async () => {
  const h = harness();
  await h.run();
  expect(h.api.createVolume).toHaveBeenCalledWith(
    expect.objectContaining({ funding_source: selected }),
  );
  expect(h.api.createVm).toHaveBeenCalledWith(
    expect.objectContaining({
      funding_source: selected,
      home_volume: "home",
      expected_home_volume_funding_version: "epoch",
      idempotency_key: "vm-key",
    }),
  );
});
it.each(["pool_id", "grant_id", "payer_account_id"])(
  "still rejects a returned mismatched %s before VM creation",
  async (field) => {
    const h = harness();
    h.volume.funding_source = {
      ...h.volume.funding_source!,
      [field]: "different",
    };
    await expect(h.run()).rejects.toThrow("does not match");
    expect(h.api.createVm).not.toHaveBeenCalled();
  },
);
it.each([
  { funding_version: "" },
  { state: "protected" },
  { stop_at: "2000-01-01" },
  { as_of: "2000-01-01" },
  { source: undefined },
])("redaction does not bypass funding validity: %j", async (patch) => {
  const h = harness();
  h.volume.funding_status = {
    ...h.volume.funding_status!,
    ...patch,
  } as ComputeVolume["funding_status"];
  await expect(h.run()).rejects.toThrow("funding is unavailable");
  expect(h.api.createVm).not.toHaveBeenCalled();
});
it("existing redacted storage still requires the exact reviewed epoch", async () => {
  const h = harness();
  h.values.create_home_volume = false;
  h.values.home_volume = "home";
  h.values.expected_home_volume_funding_version = "old";
  await expect(h.run()).rejects.toThrow("funding changed");
  expect(h.api.createVm).not.toHaveBeenCalled();
  h.values.expected_home_volume_funding_version = "epoch";
  await h.run();
  expect(h.api.createVolume).not.toHaveBeenCalled();
  expect(h.api.createVm).toHaveBeenCalledWith(
    expect.objectContaining({ expected_home_volume_funding_version: "epoch" }),
  );
});
