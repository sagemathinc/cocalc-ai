/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { vmCreateCli, volumeCreateCli } from "./compute-vms-cli";

describe("managed compute CLI equivalents", () => {
  it("includes every visible VM resource setting", () => {
    expect(
      vmCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: {
          name: "build-vm",
          zone: "us-central1-a",
          machine_type: "t2d-standard-16",
          pricing_model: "spot",
          allow_on_demand_fallback: true,
          ttl_minutes: 480,
          boot_disk_gb: 40,
          home_volume: "build-cache",
          ssh_public_key: "ssh-ed25519 AAAATEST user@example.com",
        },
      }),
    ).toBe(
      "cocalc vm create --project project-id --provider gcp --os linux --funding-mode account-prepaid --architecture x86_64 --region us-central1 --machine t2d-standard-16 --zone us-central1-a --ttl=8h --boot-disk-gb=40 --spot --allow-standard-fallback --home-volume build-cache --ssh-public-key-value 'ssh-ed25519 AAAATEST user@example.com' --wait build-vm",
    );
  });

  it("omits an optional TTL", () => {
    expect(
      vmCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: { name: "open-ended", ttl_minutes: null },
      }),
    ).not.toContain("--ttl");
  });

  it("renders an explicit Windows selection", () => {
    expect(
      vmCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: {
          name: "windows-vm",
          operating_system: "windows",
          boot_disk_gb: 80,
        },
      }),
    ).toContain("--os windows");
  });

  it("omits the no-GPU UI sentinel", () => {
    expect(
      vmCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: {
          name: "arm-vm",
          architecture: "arm64",
          machine_type: "t2a-standard-4",
          gpu_type: "none",
        },
      }),
    ).not.toContain("--gpu-type");
  });

  it("includes the fixed G2 accelerator shape", () => {
    const command = vmCreateCli({
      api: "https://staging.cocalc.ai",
      project_id: "project-id",
      values: {
        name: "l4-vm",
        provider: "gcp",
        architecture: "x86_64",
        region: "us-central1",
        zone: "us-central1-a",
        machine_type: "g2-standard-4",
        gpu_type: "nvidia-l4",
        gpu_count: 1,
        boot_disk_gb: 40,
      },
    });
    expect(command).toContain("--machine g2-standard-4");
    expect(command).toContain("--gpu-type nvidia-l4 --gpu-count 1");
    expect(command).toContain("--boot-disk-gb=40");
  });

  it("makes a deliberately keyless browser configuration explicit", () => {
    expect(
      vmCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: { name: "keyless", ssh_public_key: "" },
      }),
    ).toContain("--no-ssh-key");
  });

  it("shows the project-scoped persistent volume command", () => {
    expect(
      volumeCreateCli({
        api: "https://staging.cocalc.ai",
        project_id: "project-id",
        values: { name: "my data", zone: "us-central1-b", size_gb: 80 },
      }),
    ).toBe(
      "cocalc vm volume create --project project-id --provider gcp --funding-mode account-prepaid --region us-central1 --size-gb=80 --zone us-central1-b --wait 'my data'",
    );
  });

  it("creates and waits for a new home volume before creating the VM", () => {
    const command = vmCreateCli({
      api: "https://staging.cocalc.ai",
      project_id: "project-id",
      values: {
        name: "compute-vm",
        zone: "us-west1-a",
        machine_type: "e2-standard-2",
        pricing_model: "on_demand",
        allow_on_demand_fallback: false,
        boot_disk_gb: 20,
        create_home_volume: true,
        new_home_volume_name: "compute-vm-home",
        new_home_volume_size_gb: 100,
      },
    });
    expect(command).toContain(
      "vm volume create --project project-id --provider gcp --funding-mode account-prepaid --region us-central1 --size-gb=100 --zone us-west1-a --wait compute-vm-home",
    );
    expect(command).toContain("&& cocalc vm create");
    expect(command).toContain("--home-volume compute-vm-home");
  });
});
