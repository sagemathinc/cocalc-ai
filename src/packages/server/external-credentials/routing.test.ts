/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getConfiguredBayIdMock: jest.Mock;
let getConfiguredClusterSeedBayIdMock: jest.Mock;
let resolveAccountHomeBayMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let getInterBayBridgeMock: jest.Mock;
let upsertExternalCredentialMock: jest.Mock;
let getExternalCredentialMock: jest.Mock;
let listExternalCredentialsMock: jest.Mock;

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    getConfiguredClusterSeedBayIdMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: (...args: any[]) => getInterBayBridgeMock(...args),
}));

jest.mock("./store", () => ({
  upsertExternalCredential: (...args: any[]) =>
    upsertExternalCredentialMock(...args),
  getExternalCredential: (...args: any[]) => getExternalCredentialMock(...args),
  hasExternalCredential: jest.fn(async () => false),
  touchExternalCredential: jest.fn(async () => false),
  listExternalCredentials: (...args: any[]) =>
    listExternalCredentialsMock(...args),
  revokeExternalCredential: jest.fn(async () => true),
}));

describe("external credential bay routing", () => {
  beforeEach(() => {
    jest.resetModules();
    getConfiguredBayIdMock = jest.fn(() => "bay-local");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "bay-seed");
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-local",
    }));
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-local",
      epoch: 0,
    }));
    upsertExternalCredentialMock = jest.fn(async () => ({
      id: "credential-local",
      created: true,
    }));
    getExternalCredentialMock = jest.fn(async () => undefined);
    listExternalCredentialsMock = jest.fn(async () => []);
    getInterBayBridgeMock = jest.fn(() => ({
      externalCredentials: jest.fn(() => ({
        upsert: jest.fn(async () => ({
          id: "credential-remote",
          created: true,
        })),
        get: jest.fn(async () => undefined),
        list: jest.fn(async () => []),
      })),
    }));
  });

  it("uses the local store for account credentials on the local home bay", async () => {
    const { upsertExternalCredentialRouted } = await import("./routing");

    await upsertExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: "openai-api-key",
        scope: "account",
        owner_account_id: "11111111-1111-4111-8111-111111111111",
      },
      payload: "secret",
    });

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(upsertExternalCredentialMock).toHaveBeenCalled();
    expect(getInterBayBridgeMock).not.toHaveBeenCalled();
  });

  it("forwards account credential lists to the account home bay", async () => {
    const remoteList = jest.fn(async () => []);
    resolveAccountHomeBayMock = jest.fn(async () => ({
      home_bay_id: "bay-remote",
    }));
    getInterBayBridgeMock = jest.fn(() => ({
      externalCredentials: jest.fn(() => ({
        list: remoteList,
      })),
    }));
    const { listAccountExternalCredentialsRouted } = await import("./routing");

    await listAccountExternalCredentialsRouted({
      owner_account_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(remoteList).toHaveBeenCalledWith({
      owner_account_id: "11111111-1111-4111-8111-111111111111",
      include_revoked: false,
      provider: undefined,
      kind: undefined,
      scope: undefined,
    });
    expect(listExternalCredentialsMock).not.toHaveBeenCalled();
  });

  it("forwards project credentials to the project owning bay", async () => {
    const remoteUpsert = jest.fn(async () => ({
      id: "credential-remote",
      created: false,
    }));
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-project",
      epoch: 7,
    }));
    getInterBayBridgeMock = jest.fn(() => ({
      externalCredentials: jest.fn(() => ({
        upsert: remoteUpsert,
      })),
    }));
    const { upsertExternalCredentialRouted } = await import("./routing");

    await upsertExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: "openai-api-key",
        scope: "project",
        project_id: "22222222-2222-4222-8222-222222222222",
      },
      payload: "secret",
    });

    expect(resolveProjectBayMock).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(remoteUpsert).toHaveBeenCalled();
    expect(upsertExternalCredentialMock).not.toHaveBeenCalled();
  });

  it("stores site credentials on the seed bay", async () => {
    const remoteGet = jest.fn(async () => undefined);
    getInterBayBridgeMock = jest.fn(() => ({
      externalCredentials: jest.fn(() => ({
        get: remoteGet,
      })),
    }));
    const { getExternalCredentialRouted } = await import("./routing");

    await getExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: "openai-api-key",
        scope: "site",
      },
      touchLastUsed: false,
    });

    expect(remoteGet).toHaveBeenCalledWith({
      selector: {
        provider: "openai",
        kind: "openai-api-key",
        scope: "site",
      },
      touch_last_used: false,
    });
    expect(getExternalCredentialMock).not.toHaveBeenCalled();
  });
});
