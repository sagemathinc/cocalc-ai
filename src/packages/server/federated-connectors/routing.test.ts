/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Routing and the turn's real dependencies, with every bay call mocked.

const LOCAL = "bay-a";
let projectBay: string | undefined = LOCAL;
let settings: Record<string, unknown> = {};
const localSnapshot = jest.fn();
const remoteSnapshot = jest.fn();
const remoteClient = jest.fn(
  (_client: any, _bay: string, _timeout?: number) => ({
    snapshot: remoteSnapshot,
    beginTurn: jest.fn(async () => "remote-begin"),
  }),
);
const activeRun = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => LOCAL,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => (projectBay ? { bay_id: projectBay } : null),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "bay-home" }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/federated-connector", () => ({
  createInterBayFederatedConnectorClient: (c: any, bay: string, t?: number) =>
    remoteClient(c, bay, t),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
}));
jest.mock("@cocalc/server/agents/cocalc-connector-turn", () => ({
  assertLiveTurn: jest.fn(),
  assertTrustedSource: jest.fn(),
}));
jest.mock("@cocalc/server/agents/identity-routing", () => ({
  verifyActiveAgentRun: (opts: any) => activeRun(opts),
}));
jest.mock("./approvals", () => ({
  federationSnapshotOnOwningBay: (opts: any) => localSnapshot(opts),
  approveFederatedSharedProjectOnOwningBay: jest.fn(),
  revokeFederatedSharedProjectOnOwningBay: jest.fn(),
}));
jest.mock("./assignments", () => ({}));
jest.mock("./site-gate", () => ({}));

import {
  beginFederatedConnectorTurn,
  federatedRunActivity,
  federatedTurnDeps,
  owningBaySnapshot,
  registerFederatedBroker,
} from "./routing";
import { FEDERATED_TURN_REFUSED } from "./turn";

const PROJECT = "00000000-0000-4000-8000-000000000003";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOST = "00000000-0000-4000-8000-000000000004";
const snap = (owning_bay_id: string) => ({
  owning_bay_id,
  users_revision: 1,
  account_role: "owner",
  other_members: 0,
  pending_invites: 0,
  approval_id: null,
});

beforeEach(() => {
  projectBay = LOCAL;
  localSnapshot.mockReset();
  remoteSnapshot.mockReset();
  remoteClient.mockClear();
  activeRun.mockReset();
});

describe("owningBaySnapshot", () => {
  it("reads locally when this bay owns the project", async () => {
    localSnapshot.mockResolvedValue(snap(LOCAL));
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).resolves.toEqual(snap(LOCAL));
    expect(remoteClient).not.toHaveBeenCalled();
  });

  it("asks the owning bay with a 5 s timeout, and checks the answer's bay", async () => {
    projectBay = "bay-b";
    remoteSnapshot.mockResolvedValue(snap("bay-b"));
    await owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT });
    expect(remoteClient).toHaveBeenCalledWith(expect.anything(), "bay-b", 5000);
    remoteSnapshot.mockResolvedValue(snap("bay-c"));
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).rejects.toThrow(/owner changed/);
  });

  it("fails closed without an owner, on an error and on a timeout", async () => {
    projectBay = undefined;
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).rejects.toThrow();
    projectBay = "bay-b";
    remoteSnapshot.mockRejectedValue(Error("unreachable"));
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).rejects.toThrow();
    jest.useFakeTimers();
    try {
      remoteSnapshot.mockReturnValue(new Promise(() => {}));
      const p = owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT });
      const check = expect(p).rejects.toThrow(/timeout/);
      await jest.advanceTimersByTimeAsync(5001);
      await check;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("federatedRunActivity", () => {
  const lease = {
    account_id: ACCOUNT,
    agent_id: ACCOUNT,
    project_id: PROJECT,
    run_id: ACCOUNT,
  };

  it("is ended only on the agent store's not-active answer", async () => {
    activeRun.mockResolvedValue(1);
    expect(await federatedRunActivity(lease)).toBe("active");
    activeRun.mockRejectedValue(
      Error("agent credential is expired, revoked, or invalid"),
    );
    expect(await federatedRunActivity(lease)).toBe("ended");
    for (const err of [Error("timeout"), Error("bay unreachable"), "x"]) {
      activeRun.mockRejectedValue(err);
      expect(await federatedRunActivity(lease)).toBe("unknown");
    }
  });
});

describe("host turn calls", () => {
  it("refuse a call without an authenticated account and host", async () => {
    for (const input of [{}, { account_id: ACCOUNT }, { host_id: HOST }]) {
      await expect(beginFederatedConnectorTurn(input)).rejects.toThrow(
        FEDERATED_TURN_REFUSED,
      );
    }
  });

  it("go to the account's home bay, unchanged", async () => {
    const input = { account_id: ACCOUNT, host_id: HOST, extra: 1 };
    await expect(beginFederatedConnectorTurn(input)).resolves.toBe(
      "remote-begin",
    );
    expect(remoteClient).toHaveBeenCalledWith(
      expect.anything(),
      "bay-home",
      undefined,
    );
  });
});

describe("gate", () => {
  it("is closed until a broker registers, then follows the setting", async () => {
    const deps = federatedTurnDeps();
    settings = { federated_cli_connectors: "gcloud" };
    registerFederatedBroker(undefined);
    expect(await deps.gateOpen()).toBe(false);
    registerFederatedBroker({ site_id: "site-1", getToken: jest.fn() });
    expect(await deps.gateOpen()).toBe(true);
    expect(deps.site_id).toBe("site-1");
    settings = { federated_cli_connectors: "" };
    expect(await deps.gateOpen()).toBe(false);
    registerFederatedBroker(undefined);
  });
});
