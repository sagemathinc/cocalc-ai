/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockPublicDirectoryShares = {
  authorizeRead: jest.fn(),
  create: jest.fn(),
  copyToNewProject: jest.fn(),
  copyToProject: jest.fn(),
  getTemporaryViewerReadPolicy: jest.fn(),
  grantTemporaryViewerAccess: jest.fn(),
  listMine: jest.fn(),
  listProject: jest.fn(),
  listDirectory: jest.fn(),
  resolve: jest.fn(),
  resolveLegacyPublicDirectorySharePath: jest.fn(),
  update: jest.fn(),
  upsert: jest.fn(),
};
const mockRemoteClients: Record<string, any> = {};
const mockCreateInterBayAccountLocalClient = jest.fn(
  ({ dest_bay }: { dest_bay: string }) => mockRemoteClients[dest_bay],
);
const mockGetInterBayFabricClient = jest.fn(() => ({}));
let mockCurrentBayId = "bay-0";
let mockSeedBayId = "bay-0";
const mockListClusterBayRegistry = jest.fn();
const mockResolveProjectBayAcrossCluster = jest.fn();

jest.mock("@cocalc/backend/logger", () => () => ({
  warn: jest.fn(),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args: any[]) =>
    mockCreateInterBayAccountLocalClient(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockCurrentBayId,
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: (...args: any[]) =>
    mockListClusterBayRegistry(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => mockSeedBayId,
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBayAcrossCluster: (...args: any[]) =>
    mockResolveProjectBayAcrossCluster(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: (...args: any[]) =>
    mockGetInterBayFabricClient(...args),
}));

jest.mock("@cocalc/server/public-directory-shares", () => ({
  authorizeRead: (...args: any[]) =>
    mockPublicDirectoryShares.authorizeRead(...args),
  create: (...args: any[]) => mockPublicDirectoryShares.create(...args),
  copyToNewProject: (...args: any[]) =>
    mockPublicDirectoryShares.copyToNewProject(...args),
  copyToProject: (...args: any[]) =>
    mockPublicDirectoryShares.copyToProject(...args),
  getTemporaryViewerReadPolicy: (...args: any[]) =>
    mockPublicDirectoryShares.getTemporaryViewerReadPolicy(...args),
  grantTemporaryViewerAccess: (...args: any[]) =>
    mockPublicDirectoryShares.grantTemporaryViewerAccess(...args),
  listMine: (...args: any[]) => mockPublicDirectoryShares.listMine(...args),
  listProject: (...args: any[]) =>
    mockPublicDirectoryShares.listProject(...args),
  listDirectory: (...args: any[]) =>
    mockPublicDirectoryShares.listDirectory(...args),
  resolve: (...args: any[]) => mockPublicDirectoryShares.resolve(...args),
  resolveLegacyPublicDirectorySharePath: (...args: any[]) =>
    mockPublicDirectoryShares.resolveLegacyPublicDirectorySharePath(...args),
  update: (...args: any[]) => mockPublicDirectoryShares.update(...args),
  upsert: (...args: any[]) => mockPublicDirectoryShares.upsert(...args),
}));

import * as publicDirectoryShares from "./public-directory-shares";

function remoteClient() {
  return {
    publicDirectoryShareAuthorizeRead: jest.fn(),
    publicDirectoryShareCreate: jest.fn(),
    publicDirectoryShareCopyToNewProject: jest.fn(),
    publicDirectoryShareCopyToProject: jest.fn(),
    publicDirectoryShareGetTemporaryViewerReadPolicy: jest.fn(),
    publicDirectoryShareGrantTemporaryViewerAccess: jest.fn(),
    publicDirectoryShareListMine: jest.fn(),
    publicDirectoryShareListProject: jest.fn(),
    publicDirectoryShareListDirectory: jest.fn(),
    publicDirectoryShareResolve: jest.fn(),
    publicDirectoryShareResolveLegacyPath: jest.fn(),
    publicDirectoryShareUpdate: jest.fn(),
    publicDirectoryShareUpsert: jest.fn(),
  };
}

function notFound() {
  return new Error("public directory share not found");
}

describe("public directory share conat API routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentBayId = "bay-0";
    mockSeedBayId = "bay-0";
    mockRemoteClients["bay-1"] = remoteClient();
    mockListClusterBayRegistry.mockResolvedValue([
      { bay_id: "bay-0" },
      { bay_id: "bay-1" },
    ]);
  });

  it("resolves a share from another registered bay when local seed lookup misses", async () => {
    const share = {
      id: "share-id",
      project_id: "project-id",
      slug: "x3",
    };
    mockPublicDirectoryShares.resolve.mockRejectedValue(notFound());
    mockRemoteClients["bay-1"].publicDirectoryShareResolve.mockResolvedValue(
      share,
    );

    await expect(
      publicDirectoryShares.resolve({
        account_id: "account-id",
        slug: "x3",
      }),
    ).resolves.toBe(share);
    expect(mockPublicDirectoryShares.resolve).toHaveBeenCalledWith({
      account_id: "account-id",
      slug: "x3",
    });
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareResolve,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      slug: "x3",
    });
  });

  it("resolves a legacy URL path from another registered bay", async () => {
    mockPublicDirectoryShares.resolveLegacyPublicDirectorySharePath.mockResolvedValue(
      null,
    );
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareResolveLegacyPath.mockResolvedValue({
      path: "georeg/matrix-certificates/notebook",
    });

    await expect(
      publicDirectoryShares.resolveLegacyPublicDirectorySharePath({
        path: "georeg/matrix-certificates/notebook",
      }),
    ).resolves.toEqual({
      path: "georeg/matrix-certificates/notebook",
    });
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareResolveLegacyPath,
    ).toHaveBeenCalledWith({
      path: "georeg/matrix-certificates/notebook",
    });
    expect(mockCreateInterBayAccountLocalClient).toHaveBeenCalledWith(
      expect.objectContaining({ dest_bay: "bay-1", timeout: 2_000 }),
    );
  });

  it("continues legacy path lookup when one attached bay is unavailable", async () => {
    mockRemoteClients["bay-2"] = remoteClient();
    mockListClusterBayRegistry.mockResolvedValue([
      { bay_id: "bay-0" },
      { bay_id: "bay-1" },
      { bay_id: "bay-2" },
    ]);
    mockPublicDirectoryShares.resolveLegacyPublicDirectorySharePath.mockResolvedValue(
      null,
    );
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareResolveLegacyPath.mockRejectedValue(
      Error("bay unavailable"),
    );
    mockRemoteClients[
      "bay-2"
    ].publicDirectoryShareResolveLegacyPath.mockResolvedValue({
      path: "georeg/matrix-certificates/notebook",
    });

    await expect(
      publicDirectoryShares.resolveLegacyPublicDirectorySharePath({
        path: "georeg/matrix-certificates/notebook",
      }),
    ).resolves.toEqual({
      path: "georeg/matrix-certificates/notebook",
    });
  });

  it("grants viewer access on the bay that owns the resolved share", async () => {
    mockPublicDirectoryShares.resolve.mockRejectedValue(notFound());
    mockRemoteClients["bay-1"].publicDirectoryShareResolve.mockResolvedValue({
      id: "share-id",
      project_id: "project-id",
      slug: "x3",
    });
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareGrantTemporaryViewerAccess.mockResolvedValue({
      project_id: "project-id",
      share_id: "share-id",
    });

    await expect(
      publicDirectoryShares.grantTemporaryViewerAccess({
        account_id: "account-id",
        slug: "x3",
      }),
    ).resolves.toEqual({
      project_id: "project-id",
      share_id: "share-id",
    });
    expect(
      mockPublicDirectoryShares.grantTemporaryViewerAccess,
    ).not.toHaveBeenCalled();
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareGrantTemporaryViewerAccess,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      slug: "x3",
    });
  });

  it("routes temporary viewer read policy checks to the project owning bay", async () => {
    mockResolveProjectBayAcrossCluster.mockResolvedValue({ bay_id: "bay-1" });
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareGetTemporaryViewerReadPolicy.mockResolvedValue({
      account_id: "account-id",
      project_id: "project-id",
      read_policy: { rules: [{ action: "include", path: "share/**" }] },
    });

    await expect(
      publicDirectoryShares.getTemporaryViewerReadPolicy({
        account_id: "account-id",
        project_id: "project-id",
      }),
    ).resolves.toEqual({
      account_id: "account-id",
      project_id: "project-id",
      read_policy: { rules: [{ action: "include", path: "share/**" }] },
    });
    expect(
      mockPublicDirectoryShares.getTemporaryViewerReadPolicy,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
    });
    expect(
      mockRemoteClients["bay-1"]
        .publicDirectoryShareGetTemporaryViewerReadPolicy,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
    });
  });

  it("creates shares on the project owning bay", async () => {
    const share = {
      id: "share-id",
      project_id: "project-id",
      slug: "x3",
    };
    mockResolveProjectBayAcrossCluster.mockResolvedValue({ bay_id: "bay-1" });
    mockRemoteClients["bay-1"].publicDirectoryShareCreate.mockResolvedValue(
      share,
    );

    await expect(
      publicDirectoryShares.create({
        account_id: "account-id",
        project_id: "project-id",
        path: "x",
        slug: "x3",
      }),
    ).resolves.toBe(share);
    expect(mockPublicDirectoryShares.create).not.toHaveBeenCalled();
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareCreate,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
      path: "x",
      slug: "x3",
    });
  });

  it("merges account shares from every registered bay", async () => {
    mockPublicDirectoryShares.listMine.mockResolvedValue({
      shares: [
        {
          id: "share-local",
          slug: "local",
          updated_at: "2026-08-04T00:00:00Z",
        },
      ],
      total_count: 1,
    });
    mockRemoteClients["bay-1"].publicDirectoryShareListMine.mockResolvedValue({
      shares: [
        {
          id: "share-remote",
          slug: "remote",
          updated_at: "2026-08-05T00:00:00Z",
        },
      ],
      total_count: 1,
    });

    await expect(
      publicDirectoryShares.listMine({
        account_id: "account-id",
        include_disabled: true,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      shares: [{ id: "share-remote" }, { id: "share-local" }],
      total_count: 2,
    });
    expect(mockPublicDirectoryShares.listMine).toHaveBeenCalledWith({
      account_id: "account-id",
      include_disabled: true,
      limit: 10,
      offset: 0,
    });
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareListMine,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      include_disabled: true,
      limit: 10,
      offset: 0,
    });
  });

  it("updates shares on the bay where the share row exists", async () => {
    const share = {
      id: "share-id",
      project_id: "project-id",
      slug: "x4",
    };
    mockPublicDirectoryShares.update.mockRejectedValue(notFound());
    mockRemoteClients["bay-1"].publicDirectoryShareUpdate.mockResolvedValue(
      share,
    );

    await expect(
      publicDirectoryShares.update({
        account_id: "account-id",
        id: "share-id",
        slug: "x4",
      }),
    ).resolves.toBe(share);
    expect(mockPublicDirectoryShares.update).toHaveBeenCalledWith({
      account_id: "account-id",
      id: "share-id",
      slug: "x4",
    });
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareUpdate,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      id: "share-id",
      slug: "x4",
    });
  });

  it("merges temporary viewer read policies from registered bays", async () => {
    mockResolveProjectBayAcrossCluster.mockResolvedValue({ bay_id: "bay-0" });
    mockPublicDirectoryShares.getTemporaryViewerReadPolicy.mockResolvedValue({
      account_id: "account-id",
      project_id: "project-id",
      read_policy: undefined,
    });
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareGetTemporaryViewerReadPolicy.mockResolvedValue({
      account_id: "account-id",
      project_id: "project-id",
      read_policy: { rules: [{ action: "include", path: "share/**" }] },
    });

    await expect(
      publicDirectoryShares.getTemporaryViewerReadPolicy({
        account_id: "account-id",
        project_id: "project-id",
      }),
    ).resolves.toEqual({
      account_id: "account-id",
      project_id: "project-id",
      read_policy: { rules: [{ action: "include", path: "share/**" }] },
    });
    expect(
      mockPublicDirectoryShares.getTemporaryViewerReadPolicy,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
    });
    expect(
      mockRemoteClients["bay-1"]
        .publicDirectoryShareGetTemporaryViewerReadPolicy,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
    });
  });

  it("falls back across registered bays when authorizing a share by id", async () => {
    mockResolveProjectBayAcrossCluster.mockResolvedValue({ bay_id: "bay-0" });
    mockPublicDirectoryShares.authorizeRead.mockRejectedValue(notFound());
    mockRemoteClients[
      "bay-1"
    ].publicDirectoryShareAuthorizeRead.mockResolvedValue({
      project_id: "project-id",
      share_id: "share-id",
      read_policy: { rules: [] },
    });

    await expect(
      publicDirectoryShares.authorizeRead({
        account_id: "account-id",
        project_id: "project-id",
        share_id: "share-id",
      }),
    ).resolves.toEqual({
      project_id: "project-id",
      share_id: "share-id",
      read_policy: { rules: [] },
    });
    expect(mockPublicDirectoryShares.authorizeRead).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
      share_id: "share-id",
    });
    expect(
      mockRemoteClients["bay-1"].publicDirectoryShareAuthorizeRead,
    ).toHaveBeenCalledWith({
      account_id: "account-id",
      project_id: "project-id",
      share_id: "share-id",
    });
  });
});
