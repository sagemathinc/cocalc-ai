/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeWorkFailureState,
  computeVmNeedsProviderObservation,
  computeVmProviderObservationAge,
  computeRuntimeMetadata,
  computePostStopTransition,
  isSpotCapacityError,
  managedVmReadinessCommand,
  managedVmProjectSshConfigNeedsSync,
  managedVmProjectAccessNeedsSync,
  managedVmProjectAccessKeyFingerprint,
  managedVmProjectConfigShouldBeEnabled,
  providerComputeInstanceIsExpected,
  providerRuntimePublicAddressStatus,
  providerStartDisposition,
  RetryableComputeWorkError,
  shouldRecoverSpotCapacityFailure,
  shouldReplaceNebiusSpotInterruption,
  stoppedVmProviderInstanceNeedsReconciliation,
  runtimeIdentityChanged,
  runningVmWorkAlreadySatisfied,
  shouldRepairNebiusSshAfterRestart,
  spotCapacityRecoveryDecision,
  volumeAttachedToVm,
  vmReadinessIntentIsRunning,
} from "./worker";
import {
  effectiveComputeVolumeSizeGb,
  validComputeVolumeSizeIncrement,
} from "./volume-size";

describe("managed compute volume sizes", () => {
  it("keeps requested and effective Nebius sizes distinct", () => {
    expect(effectiveComputeVolumeSizeGb("nebius", 50)).toBe(93);
    expect(effectiveComputeVolumeSizeGb("nebius", 93)).toBe(93);
    expect(effectiveComputeVolumeSizeGb("nebius", 94)).toBe(186);
    expect(effectiveComputeVolumeSizeGb("gcp", 50)).toBe(50);
  });

  it("requires explicit Nebius allocation increments", () => {
    expect(validComputeVolumeSizeIncrement("nebius", 50)).toBe(false);
    expect(validComputeVolumeSizeIncrement("nebius", 93)).toBe(true);
    expect(validComputeVolumeSizeIncrement("nebius", 186)).toBe(true);
    expect(validComputeVolumeSizeIncrement("gcp", 50)).toBe(true);
  });
});

describe("managed VM readiness command", () => {
  it("preserves the full remote shell expression as one quoted command", () => {
    const command = managedVmReadinessCommand(
      { bootstrap_revision: 2 } as any,
      "/dev/disk/by-id/google-home-disk",
    );

    expect(command).toMatch(/^bash -lc '/);
    expect(command).toContain('test "$(id -gn)" = user');
    expect(command).toContain("! id ubuntu >/dev/null 2>&1");
    expect(command).toContain("readlink -f /dev/disk/by-id/google-home-disk");
    expect(command).toContain("bootstrap-ready");
    expect(command).toMatch(/'$/);
  });

  it("accepts a previously verified persistent boot disk after reboot", () => {
    const command = managedVmReadinessCommand({
      bootstrap_revision: 2,
      observed_bootstrap_revision: 2,
    } as any);

    expect(command).toContain(
      "test ! -e /var/lib/cocalc-managed-vm/bootstrap-ready",
    );
    expect(command).not.toContain(
      "|| cat /run/cocalc-managed-vm/bootstrap-ready",
    );
  });

  it("requires a readiness marker for a new boot disk", () => {
    const command = managedVmReadinessCommand({
      bootstrap_revision: 2,
      observed_bootstrap_revision: null,
    } as any);

    expect(command).toContain(
      "cat /var/lib/cocalc-managed-vm/bootstrap-ready 2>/dev/null || cat /run/cocalc-managed-vm/bootstrap-ready",
    );
  });

  it("uses a PowerShell readiness contract for Windows", () => {
    const command = managedVmReadinessCommand({
      operating_system: "windows",
      bootstrap_revision: 1,
    } as any);

    expect(command).toContain("powershell.exe");
    expect(command).toContain("-EncodedCommand");
    const encoded = command.split(" ").at(-1)!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("bootstrap-ready.txt");
    expect(script).toContain("Get-Service sshd");
    expect(command).not.toContain("bash -lc");
  });
});

describe("managed VM provider observations", () => {
  it("prioritizes VMs with missing or old cloud checks", () => {
    const now = Date.parse("2026-08-20T05:00:00.000Z");
    expect(computeVmProviderObservationAge({ metadata: {} } as any, now)).toBe(
      Infinity,
    );
    expect(
      computeVmProviderObservationAge(
        {
          metadata: {
            provider_observation: {
              checked_at: "2026-08-20T04:59:15.000Z",
            },
          },
        } as any,
        now,
      ),
    ).toBe(45_000);
  });

  it("does not poll intentionally stopped Nebius instances", () => {
    expect(
      computeVmNeedsProviderObservation({
        provider: "nebius",
        desired_state: "stopped",
        state: "stopped",
      }),
    ).toBe(false);
    expect(
      computeVmNeedsProviderObservation({
        provider: "nebius",
        desired_state: "stopped",
        state: "stopping",
      }),
    ).toBe(true);
    expect(
      computeVmNeedsProviderObservation({
        provider: "gcp",
        desired_state: "stopped",
        state: "stopped",
      }),
    ).toBe(true);
  });

  it("reconciles unexpected active instances for stopped VMs", () => {
    expect(stoppedVmProviderInstanceNeedsReconciliation("RUNNING")).toBe(true);
    expect(stoppedVmProviderInstanceNeedsReconciliation("STARTING")).toBe(true);
    expect(stoppedVmProviderInstanceNeedsReconciliation(undefined)).toBe(true);
    expect(stoppedVmProviderInstanceNeedsReconciliation("STOPPED")).toBe(false);
    expect(stoppedVmProviderInstanceNeedsReconciliation("TERMINATED")).toBe(
      false,
    );
  });
});

describe("Nebius Spot interruption recovery", () => {
  const interrupted = {
    provider: "nebius",
    desired_pricing_model: "spot",
    effective_pricing_model: "spot",
    state: "recovering",
    spot_recovery_state: {
      phase: "retrying_spot",
      last_preempted_at: "2026-08-22T00:00:00.000Z",
    },
  } as any;

  it("replaces an interrupted instance to obtain a fresh placement", () => {
    expect(shouldReplaceNebiusSpotInterruption(interrupted)).toBe(true);
  });

  it("does not replace unrelated recovery or GCP instances", () => {
    expect(
      shouldReplaceNebiusSpotInterruption({
        ...interrupted,
        spot_recovery_state: { phase: "retrying_spot" },
      }),
    ).toBe(false);
    expect(
      shouldReplaceNebiusSpotInterruption({ ...interrupted, provider: "gcp" }),
    ).toBe(false);
    expect(
      shouldReplaceNebiusSpotInterruption({
        ...interrupted,
        effective_pricing_model: "on_demand",
      }),
    ).toBe(false);
  });
});

describe("managed VM project SSH config reconciliation", () => {
  it("keeps active project SSH config while the VM is stopped", () => {
    expect(
      managedVmProjectConfigShouldBeEnabled({ revoked_at: null } as any),
    ).toBe(true);
    expect(
      managedVmProjectConfigShouldBeEnabled({ revoked_at: new Date() } as any),
    ).toBe(false);
  });

  it("rewrites legacy aliases even when their old state is ready", () => {
    expect(
      managedVmProjectSshConfigNeedsSync({
        name: "arm1",
        metadata: {
          project_ssh_config: {
            state: "ready",
            alias: "vm-arm1-bab319f4",
          },
        },
      } as any),
    ).toBe(true);
    expect(
      managedVmProjectSshConfigNeedsSync({
        name: "arm1",
        metadata: {
          project_ssh_config: { state: "ready", alias: "arm1" },
        },
      } as any),
    ).toBe(false);
  });

  it("detects key removals and unfinished access state", () => {
    const access = [
      {
        project_id: "project-a",
        ssh_public_key: "ssh-ed25519 AAAA project-a",
        state: "ready",
        revoked_at: null,
      },
      {
        project_id: "project-b",
        ssh_public_key: "ssh-ed25519 BBBB project-b",
        state: "revoked",
        revoked_at: new Date(),
      },
    ] as any;
    expect(
      managedVmProjectAccessNeedsSync(
        {
          metadata: {
            project_ssh_public_keys: ["ssh-ed25519 AAAA project-a"],
            project_ssh_provider_key_fingerprint:
              managedVmProjectAccessKeyFingerprint(access),
          },
        },
        access,
      ),
    ).toBe(false);
    expect(
      managedVmProjectAccessNeedsSync(
        {
          metadata: {
            project_ssh_public_keys: [
              "ssh-ed25519 AAAA project-a",
              "ssh-ed25519 BBBB project-b",
            ],
          },
        },
        access,
      ),
    ).toBe(true);
    expect(
      managedVmProjectAccessNeedsSync(
        {
          metadata: {
            project_ssh_public_keys: ["ssh-ed25519 AAAA project-a"],
          },
        },
        access,
      ),
    ).toBe(true);
    expect(
      managedVmProjectAccessNeedsSync(
        {
          metadata: {
            project_ssh_public_keys: ["ssh-ed25519 AAAA project-a"],
          },
        },
        access,
        { require_provider_persistence: false },
      ),
    ).toBe(false);
    expect(
      managedVmProjectAccessNeedsSync(
        { metadata: { project_ssh_public_keys: [] } },
        [{ ...access[0], state: "pending" }],
      ),
    ).toBe(true);
  });
});

describe("compute VM work failure state", () => {
  it("keeps scheduled Spot retries in recovering state", () => {
    const retry = new RetryableComputeWorkError(
      "Spot capacity is unavailable",
      new Date("2026-08-04T00:00:00.000Z"),
    );

    expect(computeWorkFailureState(retry)).toBe("recovering");
    expect(retry.retryAt.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });

  it("keeps volume dependency retries in provisioning state", () => {
    const retry = new RetryableComputeWorkError(
      "waiting for home volume",
      new Date("2026-08-04T00:00:02.000Z"),
      "provisioning",
    );

    expect(computeWorkFailureState(retry)).toBe("provisioning");
  });

  it("matches Nebius inventory by opaque ID or stable provider name", () => {
    const vm = {
      provider: "nebius",
      provider_instance_id: "opaque-nebius-id",
      metadata: { provider_instance_name: "cocalc-vm-stable" },
    } as any;
    expect(
      providerComputeInstanceIsExpected(
        {
          provider: "nebius",
          instance_id: "opaque-nebius-id",
          name: "cocalc-vm-stable",
        },
        [vm],
      ),
    ).toBe(true);
    expect(
      providerComputeInstanceIsExpected(
        {
          provider: "nebius",
          instance_id: "different-opaque-id",
          name: "cocalc-vm-stable",
        },
        [vm],
      ),
    ).toBe(true);
    expect(
      providerComputeInstanceIsExpected(
        {
          provider: "nebius",
          instance_id: "unknown",
          name: "cocalc-vm-unknown",
        },
        [vm],
      ),
    ).toBe(false);
  });

  it("matches an attached volume against the provider's opaque VM ID", () => {
    const vm = { provider_instance_id: "opaque-nebius-id" } as any;
    expect(volumeAttachedToVm(["opaque-nebius-id"], vm)).toBe(true);
    expect(
      volumeAttachedToVm(
        [
          "compute/v1/disks/disk-1/users/instances/opaque-nebius-id",
          "compute/v1/disks/disk-1/users/instances/another-instance",
        ],
        vm,
      ),
    ).toBe(true);
    expect(
      volumeAttachedToVm(
        ["compute/v1/disks/disk-1/users/instances/provider-name-only"],
        vm,
      ),
    ).toBe(false);
  });

  it("classifies terminal work errors as failed", () => {
    expect(
      computeWorkFailureState(new Error("invalid provider response")),
    ).toBe("failed");
  });

  it("recognizes provider capacity errors as retryable Spot failures", () => {
    expect(
      isSpotCapacityError(
        new Error("ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS: unavailable"),
      ),
    ).toBe(true);
    expect(isSpotCapacityError(new Error("invalid machine type"))).toBe(false);
  });

  it("does not treat delayed Nebius networking as Spot exhaustion", () => {
    expect(
      providerRuntimePublicAddressStatus({
        provider: "nebius",
        expected: "203.0.113.10",
        observed: undefined,
      }),
    ).toBe("pending");
    expect(
      providerRuntimePublicAddressStatus({
        provider: "nebius",
        expected: undefined,
        observed: "203.0.113.11",
      }),
    ).toBe("ready");
    expect(
      shouldRecoverSpotCapacityFailure(
        {
          desired_pricing_model: "spot",
          effective_pricing_model: "spot",
        } as any,
        new Error(
          "Nebius accepted the VM and is still assigning its public IP",
        ),
      ),
    ).toBe(false);
  });

  it("enters Spot recovery only for explicit capacity failures", () => {
    const vm = {
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
    } as any;
    expect(
      shouldRecoverSpotCapacityFailure(
        vm,
        new Error("RESOURCE_POOL_EXHAUSTED: no capacity"),
      ),
    ).toBe(true);
    expect(
      shouldRecoverSpotCapacityFailure(
        vm,
        new Error("SSH readiness timed out for 203.0.113.10"),
      ),
    ).toBe(false);
  });

  it("does not start an instance the provider already reports running", () => {
    expect(providerStartDisposition("running")).toBe("ready");
    expect(providerStartDisposition("starting")).toBe("wait");
    expect(providerStartDisposition("missing")).toBe("provision");
    expect(providerStartDisposition("stopped")).toBe("start");
  });

  it("discards stale running work after the VM becomes ready", () => {
    expect(
      runningVmWorkAlreadySatisfied({
        state: "ready",
        desired_state: "running",
      } as any),
    ).toBe(true);
    expect(
      runningVmWorkAlreadySatisfied({
        state: "starting",
        desired_state: "running",
      } as any),
    ).toBe(false);
    expect(
      runningVmWorkAlreadySatisfied(
        {
          state: "ready",
          desired_state: "running",
        } as any,
        { providerConfirmedMissing: true },
      ),
    ).toBe(false);
  });

  it("cancels readiness polling when newer intent stops or deletes the VM", () => {
    expect(
      vmReadinessIntentIsRunning({ desired_state: "running" } as any),
    ).toBe(true);
    expect(
      vmReadinessIntentIsRunning({ desired_state: "stopped" } as any),
    ).toBe(false);
    expect(
      vmReadinessIntentIsRunning({ desired_state: "deleted" } as any),
    ).toBe(false);
    expect(vmReadinessIntentIsRunning(undefined)).toBe(false);
  });

  it("repairs a previously verified Nebius VM that loses its managed SSH key", () => {
    const vm = {
      provider: "nebius",
      desired_state: "running",
      ready_at: new Date(),
      metadata: { provider_generation_provisioning: false },
    } as any;
    expect(
      shouldRepairNebiusSshAfterRestart(
        vm,
        new Error("user@host: Permission denied (publickey)."),
      ),
    ).toBe(true);
    expect(
      shouldRepairNebiusSshAfterRestart(
        { ...vm, ready_at: null },
        new Error("Permission denied (publickey)."),
      ),
    ).toBe(false);
    expect(
      shouldRepairNebiusSshAfterRestart(
        { ...vm, metadata: { provider_generation_provisioning: true } },
        new Error("Permission denied (publickey)."),
      ),
    ).toBe(false);
    expect(
      shouldRepairNebiusSshAfterRestart(vm, new Error("TCP 22 timeout")),
    ).toBe(false);
  });

  it("uses the configured Spot retry threshold before Standard fallback", () => {
    const first = spotCapacityRecoveryDecision(
      {
        allow_on_demand_fallback: true,
        spot_recovery_policy: {
          max_restore_attempts_before_fallback: 2,
          spot_restore_backoff_seconds: 15,
        },
        spot_recovery_state: { phase: "idle", attempt: 0 },
      } as any,
      Date.parse("2026-08-20T00:00:00.000Z"),
    );
    expect(first).toMatchObject({ attempt: 1, fallback: false });
    expect(first.retryAt.toISOString()).toBe("2026-08-20T00:00:15.000Z");

    const second = spotCapacityRecoveryDecision(
      {
        allow_on_demand_fallback: true,
        spot_recovery_policy: {
          max_restore_attempts_before_fallback: 2,
          spot_restore_backoff_seconds: 15,
        },
        spot_recovery_state: { phase: "retrying_spot", attempt: 1 },
      } as any,
      Date.parse("2026-08-20T00:00:00.000Z"),
    );
    expect(second).toMatchObject({ attempt: 2, fallback: true });
  });

  it("preserves and refreshes provider network identity", () => {
    expect(
      computeRuntimeMetadata(
        {
          private_ip: "10.0.0.1",
          internal_hostname: "old.internal",
          boot_disk_name: "disk-1",
        },
        {
          private_ip: "10.0.0.2",
          internal_hostname: "new.internal",
          metadata: { machine_type: "e2-standard-2" },
        },
      ),
    ).toEqual({
      private_ip: "10.0.0.2",
      internal_hostname: "new.internal",
      boot_disk_name: "disk-1",
      machine_type: "e2-standard-2",
    });
  });

  it("converges the GCP numeric instance identity used for egress metering", () => {
    expect(
      runtimeIdentityChanged(
        { private_ip: "10.0.0.2" },
        {
          private_ip: "10.0.0.2",
          metadata: { gcp_instance_id: "1234567890" },
        },
      ),
    ).toBe(true);
    expect(
      runtimeIdentityChanged(
        { private_ip: "10.0.0.2", gcp_instance_id: "1234567890" },
        {
          private_ip: "10.0.0.2",
          metadata: { gcp_instance_id: "1234567890" },
        },
      ),
    ).toBe(false);
  });

  it("honors newer durable intent after a provider stop completes", () => {
    expect(computePostStopTransition("stopped")).toEqual({
      state: "stopped",
      action: undefined,
    });
    expect(computePostStopTransition("running")).toEqual({
      state: "starting",
      action: "start",
    });
    expect(computePostStopTransition("deleted")).toEqual({
      state: "deleting",
      action: "delete",
    });
  });
});
