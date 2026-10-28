const removeHostSshKnownHostAliasMock = jest.fn();

jest.mock("@cocalc/server/cloud/host-ssh-known-hosts", () => ({
  removeHostSshKnownHostAlias: (...args: any[]) =>
    removeHostSshKnownHostAliasMock(...args),
}));

import {
  deleteHostInternalHelper,
  markHostDeprovisionedInternal,
} from "./hosts-teardown";

describe("hosts teardown helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    removeHostSshKnownHostAliasMock.mockResolvedValue(undefined);
  });

  it("clears host-scoped runtime deployments when marking a host deprovisioned", async () => {
    const clearHostRuntimeDeployments = jest.fn(async () => undefined);
    const updateHostDeprovisionedRecord = jest.fn(async () => undefined);
    const markHostProjectsUnprovisioned = jest.fn(async () => undefined);

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
      releaseHostContentDns: jest.fn(async () => undefined),
      alertAdmin: jest.fn(async () => undefined),
      logWarn: jest.fn(),
      updateHostDeprovisionedRecord,
      markHostProjectsUnprovisioned,
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
    expect(markHostProjectsUnprovisioned).toHaveBeenCalledWith(
      "e5536552-6cb0-4426-b214-212af4779efd",
    );
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: "e5536552-6cb0-4426-b214-212af4779efd",
      reason: "delete",
    });
  });

  describe("project content DNS on force deprovision", () => {
    const content_dns = {
      name: "*.h-e55365526cb04426b214212af4779efd.usercontent.example.org",
      record_id: "rec-1",
      domain: "usercontent.example.org",
    };
    const run = async (releaseHostContentDns: jest.Mock) => {
      const updateHostDeprovisionedRecord = jest.fn(async () => undefined);
      const logWarn = jest.fn();
      const alertAdmin = jest.fn(async (_opts: any) => undefined);
      await markHostDeprovisionedInternal({
        row: {
          id: "e5536552-6cb0-4426-b214-212af4779efd",
          metadata: {
            machine: { cloud: "gcp" },
            dns: { record_id: "dns-1" },
            cloudflare_tunnel: { id: "tunnel-1" },
            content_dns,
          },
        },
        action: "delete",
        logStatusUpdate: jest.fn(),
        revokeProjectHostTokensForHost: jest.fn(async () => undefined),
        // a tunnel site: the host record cleanup takes the tunnel branch
        hasCloudflareTunnel: async () => true,
        deleteCloudflareTunnel: jest.fn(async () => undefined),
        hasDns: async () => true,
        deleteHostDns: jest.fn(async () => undefined),
        releaseHostContentDns,
        alertAdmin,
        logWarn,
        updateHostDeprovisionedRecord,
        markHostProjectsUnprovisioned: jest.fn(async () => undefined),
        clearProjectHostMetrics: jest.fn(async () => undefined),
        clearHostRuntimeDeployments: jest.fn(async () => undefined),
        logCloudVmEvent: jest.fn(async () => undefined),
        normalizeProviderId: (provider) => provider,
      });
      return { updateHostDeprovisionedRecord, logWarn, alertAdmin };
    };

    it("removes it whatever the route mode, then drops the record", async () => {
      const releaseHostContentDns = jest.fn(async () => undefined);
      const { updateHostDeprovisionedRecord, alertAdmin } = await run(
        releaseHostContentDns,
      );
      expect(releaseHostContentDns).toHaveBeenCalledTimes(1);
      expect(alertAdmin).not.toHaveBeenCalled();
      expect(updateHostDeprovisionedRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          nextMetadata: expect.not.objectContaining({ content_dns: expect.anything() }),
        }),
      );
    });

    it("keeps the record for a retry when removal fails", async () => {
      const releaseHostContentDns = jest.fn(async () => {
        throw new Error("forbidden");
      });
      const { updateHostDeprovisionedRecord, logWarn, alertAdmin } = await run(
        releaseHostContentDns,
      );
      // An admin hears about it: the sweeper can't help if the token is the cause.
      expect(alertAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining("content DNS not removed"),
          body: expect.stringContaining(content_dns.name),
        }),
      );
      expect(updateHostDeprovisionedRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          nextMetadata: expect.objectContaining({ content_dns }),
        }),
      );
      expect(logWarn).toHaveBeenCalledWith(
        "force deprovision content DNS cleanup failed",
        expect.objectContaining({ err: "Error: forbidden" }),
      );
    });
  });

  it("clears host-scoped runtime deployments for local deprovisioned deletes", async () => {
    const clearHostRuntimeDeployments = jest.fn(async () => undefined);
    const markHostProjectsUnprovisioned = jest.fn(async () => undefined);

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
      closeHostBillingSession: jest.fn(async () => undefined),
      markHostDeleted: jest.fn(async () => undefined),
      markHostDeprovisioning: jest.fn(async () => undefined),
      markHostStoppedDeprovisioned: jest.fn(async () => undefined),
      markHostProjectsUnprovisioned,
      clearHostRuntimeDeployments,
    });

    expect(markHostProjectsUnprovisioned).toHaveBeenCalledWith(
      "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
    );
    expect(clearHostRuntimeDeployments).toHaveBeenCalledWith({
      host_id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
    });
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
      reason: "delete",
    });
  });

  it("deletes not-provisioned cloud hosts without enqueueing cloud teardown", async () => {
    const markHostDeleted = jest.fn(async () => undefined);
    const enqueueCloudVmWork = jest.fn(async () => undefined);
    const markHostProjectsUnprovisioned = jest.fn(async () => undefined);
    const order: string[] = [];
    const closeHostBillingSession = jest.fn(async () => {
      order.push("billing");
    });
    markHostDeleted.mockImplementation(async () => {
      order.push("deleted");
    });

    await deleteHostInternalHelper({
      id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
      loadOwnedHost: async () => ({
        id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
        status: "off",
        metadata: { machine: { cloud: "gcp" } },
      }),
      normalizeProviderId: (provider) => provider,
      setHostDesiredStateInternal: jest.fn(async () => undefined),
      enqueueCloudVmWork,
      logStatusUpdate: jest.fn(),
      closeHostBillingSession,
      markHostDeleted,
      markHostDeprovisioning: jest.fn(async () => undefined),
      markHostStoppedDeprovisioned: jest.fn(async () => undefined),
      markHostProjectsUnprovisioned,
      clearHostRuntimeDeployments: jest.fn(async () => undefined),
    });

    expect(markHostProjectsUnprovisioned).toHaveBeenCalledWith(
      "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
    );
    expect(markHostDeleted).toHaveBeenCalledWith(
      "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
    );
    expect(closeHostBillingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
      }),
    );
    expect(order).toEqual(["billing", "deleted"]);
    expect(enqueueCloudVmWork).not.toHaveBeenCalled();
    expect(removeHostSshKnownHostAliasMock).toHaveBeenCalledWith({
      host_id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
      reason: "delete",
    });
  });

  it("keeps the host visible when billing cannot be closed", async () => {
    const markHostDeleted = jest.fn(async () => undefined);

    await expect(
      deleteHostInternalHelper({
        id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
        loadOwnedHost: async () => ({
          id: "f55ca72e-2d0a-4a93-a1a7-080ebcc7abcb",
          status: "deprovisioned",
          metadata: { machine: { cloud: "gcp" } },
        }),
        normalizeProviderId: (provider) => provider,
        setHostDesiredStateInternal: jest.fn(async () => undefined),
        enqueueCloudVmWork: jest.fn(async () => undefined),
        logStatusUpdate: jest.fn(),
        closeHostBillingSession: jest.fn(async () => {
          throw new Error("billing unavailable");
        }),
        markHostDeleted,
        markHostDeprovisioning: jest.fn(async () => undefined),
        markHostStoppedDeprovisioned: jest.fn(async () => undefined),
        markHostProjectsUnprovisioned: jest.fn(async () => undefined),
        clearHostRuntimeDeployments: jest.fn(async () => undefined),
      }),
    ).rejects.toThrow("billing unavailable");

    expect(markHostDeleted).not.toHaveBeenCalled();
  });
});
