/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  gcpInstanceIdForEgress,
  isProviderNotFound,
  managedVmBootstrapScript,
  managedWindowsSshKeysScript,
  managedWindowsVmBootstrapScript,
  mergeManagedNebiusSpec,
  nebiusManagedSshKeySyncArgs,
  providerComputeStatusWithPresence,
  providerComputeSshHost,
  providerInstanceIdIsProvisional,
} from "./provider";
import type { ComputeVmRow, ComputeVolumeRow } from "./types";

describe("managedVmBootstrapScript", () => {
  const vm = {
    provider: "gcp",
    ssh_public_key: "ssh-ed25519 AAAAOWNER owner",
    bootstrap_revision: 2,
    metadata: {
      ssh_public_keys: ["ssh-ed25519 AAAACONTROLLER controller"],
      project_ssh_public_keys: ["ssh-ed25519 AAAAPROJECT project"],
    },
  } as ComputeVmRow;

  function decodeBootstrapKeys(script: string): string {
    const encoded = script.match(/printf '%s' '([^']+)' \| base64 -d/)?.[1];
    expect(encoded).toBeDefined();
    return Buffer.from(encoded!, "base64").toString("utf8");
  }

  it("creates only the v2 user and readiness contract without a volume", () => {
    const script = managedVmBootstrapScript(vm);

    expect(script).toContain("useradd --uid 1001 --gid user --create-home");
    expect(script).toContain('test "$(id -u user)" = 1001');
    expect(script).toContain('test "$(id -gn user)" = user');
    expect(script).toContain("user_gid=$(id -g user)");
    expect(script).toContain("userdel --remove ubuntu");
    expect(script).toContain("user ALL=(ALL) NOPASSWD:ALL");
    expect(script).toContain("/home/user/.ssh/authorized_keys");
    expect(decodeBootstrapKeys(script)).toBe(
      "ssh-ed25519 AAAAOWNER owner\nssh-ed25519 AAAACONTROLLER controller\nssh-ed25519 AAAAPROJECT project\n",
    );
    expect(script).toContain("/var/lib/cocalc-managed-vm/bootstrap-ready");
    expect(script).toContain("/run/cocalc-managed-vm/bootstrap-ready");
    expect(script).toContain("'2'");
    expect(script).not.toContain("/work");
  });

  it("mounts persistent home and installs an idempotent ext4 growth timer", () => {
    const script = managedVmBootstrapScript(vm, {
      provider_disk_id: "cocalc-vol-test",
    } as ComputeVolumeRow);

    expect(script).toContain("device=/dev/disk/by-id/google-cocalc-vol-test");
    expect(script).toContain("UUID=$uuid /home/user ext4");
    expect(script).toContain("rmdir /home/user/lost+found 2>/dev/null || true");
    expect(script).toContain(
      'chown -R "$user_uid:$user_gid" /mnt/cocalc-managed-home',
    );
    expect(script).toContain("cocalc-grow-home-filesystem.timer");
    expect(script).toContain("OnUnitActiveSec=30s");
    expect(script).toContain('readlink -f "$mounted_device"');
    expect(script).toContain("filesystem_bytes=$((block_size * block_count))");
    expect(script).toContain('resize2fs "$device"');
    expect(script).toContain(
      "systemctl enable --now cocalc-grow-home-filesystem.timer",
    );
    expect(script).not.toContain("/work");
  });

  it("restores Nebius managed SSH keys on every boot", () => {
    const script = managedVmBootstrapScript({
      ...vm,
      provider: "nebius",
    } as ComputeVmRow);

    expect(script).toContain("cocalc-restore-managed-ssh-keys.service");
    expect(script).toContain("Before=ssh.service sshd.service");
    expect(script).toContain("/var/lib/cocalc-managed-vm/authorized_keys");
    expect(decodeBootstrapKeys(script)).toBe(
      "ssh-ed25519 AAAAOWNER owner\nssh-ed25519 AAAACONTROLLER controller\nssh-ed25519 AAAAPROJECT project\n",
    );
  });
});

describe("nebiusManagedSshKeySyncArgs", () => {
  it("passes the entire remote key update as one OpenSSH argument", () => {
    const args = nebiusManagedSshKeySyncArgs({
      privateKeyPath: "/controller/id_ed25519",
      host: "203.0.113.10",
      encoded: "QUJDRAo=",
    });
    const hostIndex = args.indexOf("user@203.0.113.10");

    expect(hostIndex).toBeGreaterThan(0);
    expect(args.slice(hostIndex + 1)).toHaveLength(1);
    expect(args.at(-1)).toContain("tmp=$(mktemp)");
    expect(args.at(-1)).toContain("printf %s QUJDRAo=");
    expect(args.at(-1)).not.toContain("bash -lc");
  });
});

describe("managedWindowsVmBootstrapScript", () => {
  it("encodes approved keys and preserves strict Windows ACL setup", () => {
    const script = managedWindowsSshKeysScript([
      "ssh-ed25519 AAAAOWNER owner",
      "ssh-ed25519 AAAACONTROLLER controller",
      "ssh-ed25519 AAAAOWNER owner",
    ]);

    expect(script).toContain('$userHome = "C:\\Users\\user"');
    expect(script).toContain("authorized_keys");
    expect(script).toContain("icacls.exe");
    expect(script).not.toContain("ssh-ed25519 AAAAOWNER");
    const encoded = script.match(/FromBase64String\("([^"]+)"\)/)?.[1];
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(
      "ssh-ed25519 AAAAOWNER owner\nssh-ed25519 AAAACONTROLLER controller\n",
    );
  });

  it("creates a Windows user, OpenSSH service, private RDP, and readiness marker", () => {
    const script = managedWindowsVmBootstrapScript({
      ssh_public_key: "ssh-ed25519 AAAAOWNER owner",
      bootstrap_revision: 1,
      metadata: { ssh_public_keys: ["ssh-ed25519 AAAACONTROLLER controller"] },
    } as ComputeVmRow);

    expect(script).toContain('New-LocalUser -Name "user"');
    expect(script).toContain('Get-LocalGroup -SID "S-1-5-32-544"');
    expect(script).toContain("$_.SID.Value -eq $account.SID.Value");
    expect(script).toContain("google-compute-engine-ssh");
    expect(script).toContain("AuthorizedKeysFile .ssh/authorized_keys");
    expect(script).toContain("fDenyTSConnections");
    expect(script).toContain("bootstrap-ready.txt");
    expect(script).toContain('$userHome = "C:\\Users\\user"');
    expect(script).not.toMatch(/\$home\s*=/i);
    expect(script).not.toContain("ssh-ed25519 AAAAOWNER");
  });
});

describe("mergeManagedNebiusSpec", () => {
  it("preserves the CUDA image selected by shared host provisioning", () => {
    const result = mergeManagedNebiusSpec(
      {
        name: "base",
        region: "us-central1",
        cpu: 16,
        ram_gb: 200,
        disk_gb: 0,
        metadata: {
          source_image_family: "ubuntu24.04-cuda13.0",
          platform: "gpu-h200-sxm",
        },
      },
      {
        name: "managed",
        region: "us-central1",
        cpu: 16,
        ram_gb: 200,
        disk_gb: 0,
        metadata: { public_address_id: "address-1" },
      },
      "security-group-1",
    );

    expect(result.metadata).toEqual(
      expect.objectContaining({
        source_image_family: "ubuntu24.04-cuda13.0",
        platform: "gpu-h200-sxm",
        public_address_id: "address-1",
        security_group_ids: ["security-group-1"],
      }),
    );
  });
});

describe("isProviderNotFound", () => {
  it("recognizes the JSON-shaped Google API error returned for an absent VM", () => {
    expect(
      isProviderNotFound(
        new Error(`{
  "error": {
    "code": 404,
    "message": "The resource 'projects/test/zones/test/instances/missing' was not found"
  }
}`),
      ),
    ).toBe(true);
  });
});

describe("providerComputeStatusWithPresence", () => {
  it("does not confuse a deleted provider instance with a stopped one", () => {
    expect(providerComputeStatusWithPresence("stopped", undefined)).toBe(
      "missing",
    );
    expect(
      providerComputeStatusWithPresence("stopped", {
        instance_id: "instance-1",
      }),
    ).toBe("stopped");
    expect(
      providerComputeStatusWithPresence("starting", {
        instance_id: "instance-1",
        metadata: { provider_state: "STOPPING" },
      }),
    ).toBe("stopping");
  });
});

describe("providerComputeSshHost", () => {
  it("prefers the reserved IP while newly published DNS is propagating", () => {
    expect(
      providerComputeSshHost({
        public_ip: "203.0.113.10",
        public_hostname: "vm.example.test",
      } as any),
    ).toBe("203.0.113.10");
    expect(
      providerComputeSshHost({
        public_ip: null,
        public_hostname: "vm.example.test",
      } as any),
    ).toBe("vm.example.test");
  });
});

describe("providerInstanceIdIsProvisional", () => {
  it("recognizes a Nebius provider name before an instance is created", () => {
    expect(
      providerInstanceIdIsProvisional({
        provider: "nebius",
        provider_instance_id: "cocalc-vm-provisional-name",
        metadata: { provider_instance_name: "cocalc-vm-provisional-name" },
      }),
    ).toBe(true);
  });

  it("rejects actual Nebius IDs and GCP instance names", () => {
    expect(
      providerInstanceIdIsProvisional({
        provider: "nebius",
        provider_instance_id: "computeinstance-e00actual",
        metadata: { provider_instance_name: "cocalc-vm-name" },
      }),
    ).toBe(false);
    expect(
      providerInstanceIdIsProvisional({
        provider: "gcp",
        provider_instance_id: "cocalc-vm-name",
        metadata: { provider_instance_name: "cocalc-vm-name" },
      }),
    ).toBe(false);
    expect(
      providerInstanceIdIsProvisional({
        provider: "nebius",
        provider_instance_id: undefined,
        metadata: {},
      }),
    ).toBe(false);
  });
});

describe("gcpInstanceIdForEgress", () => {
  it("returns the observed numeric provider identity", () => {
    expect(
      gcpInstanceIdForEgress({
        id: "vm-1",
        metadata: { runtime: { gcp_instance_id: "1234567890" } },
      } as ComputeVmRow),
    ).toBe("1234567890");
  });

  it("treats a deleted VM that never became ready as zero egress", () => {
    expect(
      gcpInstanceIdForEgress({
        id: "vm-1",
        deleted_at: new Date(),
        ready_at: null,
      } as ComputeVmRow),
    ).toBeUndefined();
  });

  it("rejects a missing identity for active or formerly ready VMs", () => {
    expect(() =>
      gcpInstanceIdForEgress({ id: "vm-active" } as ComputeVmRow),
    ).toThrow("no GCP numeric instance id");
    expect(() =>
      gcpInstanceIdForEgress({
        id: "vm-ready",
        ready_at: new Date(),
        deleted_at: new Date(),
      } as ComputeVmRow),
    ).toThrow("no GCP numeric instance id");
  });
});
