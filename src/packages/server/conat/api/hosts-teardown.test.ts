import {
  deleteHostInternalHelper,
  markHostDeprovisionedInternal,
} from "./hosts-teardown";

describe("hosts teardown helpers", () => {
  it("clears host-scoped runtime deployments when marking a host deprovisioned", async () => {
    const clearHostRuntimeDeployments = jest.fn(async () => undefined);
    const updateHostDeprovisionedRecord = jest.fn(async () => undefined);

    await markHostDeprovisionedInternal({
      row: {
        id: "e5536552-6cb0-4426-b214-212af4779efd",
        metadata: {
          machine: { cloud: "gcp" },
          runtime: { instance_id: "vm-1" },
          dns: { record_id: "dns-1" },
          runtime_deployments: {
            last_known_good_versions: { "project-host": "bundle-v1" },
          },
        },
      },
      action: "delete",
      logStatusUpdate: jest.fn(),
      revokeProjectHostTokensForHost: jest.fn(async () => undefined),
      hasCloudflareTunnel: async () => false,
      deleteCloudflareTunnel: jest.fn(async () => undefined),
      hasDns: async () => false,
      deleteHostDns: jest.fn(async () => undefined),
      logWarn: jest.fn(),
      updateHostDeprovisionedRecord,
      clearProjectHostMetrics: jest.fn(async () => undefined),
      clearHostRuntimeDeployments,
      logCloudVmEvent: jest.fn(async () => undefined),
      normalizeProviderId: (provider) => provider,
    });

    expect(clearHostRuntimeDeployments).toHaveBeenCalledWith({
      host_id: "e5536552-6cb0-4426-b214-212af4779efd",
    });
    expect(updateHostDeprovisionedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        nextMetadata: expect.not.objectContaining({
          runtime_deployments: expect.anything(),
        }),
      }),
    );
  });

  it("clears host-scoped runtime deployments for local deprovisioned deletes", async () => {
    const clearHostRuntimeDeployments = jest.fn(async () => undefined);

    await deleteHostInternalHelper({
      id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
      loadOwnedHost: async () => ({
        id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
        status: "running",
        metadata: { machine: {} },
      }),
      normalizeProviderId: () => undefined,
      setHostDesiredStateInternal: jest.fn(async () => undefined),
      enqueueCloudVmWork: jest.fn(async () => undefined),
      logStatusUpdate: jest.fn(),
      markHostDeleted: jest.fn(async () => undefined),
      markHostDeprovisioning: jest.fn(async () => undefined),
      markHostStoppedDeprovisioned: jest.fn(async () => undefined),
      clearHostRuntimeDeployments,
    });

    expect(clearHostRuntimeDeployments).toHaveBeenCalledWith({
      host_id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
    });
  });
});
