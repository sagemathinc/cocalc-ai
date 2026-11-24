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
const remoteBegin = jest.fn(async (_opts: any): Promise<any> => "remote-begin");
const remoteClient = jest.fn(
  (_client: any, _bay: string, _timeout?: number) => ({
    snapshot: remoteSnapshot,
    beginTurn: remoteBegin,
    endTurn: remoteBegin,
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
let homeBay: () => Promise<{ home_bay_id?: string }> = async () => ({
  home_bay_id: "bay-home",
});
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: () => homeBay(),
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
jest.mock("@cocalc/server/agents/store", () => ({
  AGENT_RUN_NOT_ACTIVE: "agent credential is expired, revoked, or invalid",
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
  endFederatedConnectorTurn,
  federatedRunActivity,
  federatedTurnDeps,
  federatedBrokerRegistration,
  owningBaySnapshot,
  parseFederationSnapshot,
  setFederatedBrokerMintClient,
  setFederatedHubReadiness,
} from "./routing";
import {
  FEDERATED_CONNECTOR_UNAVAILABLE,
  FEDERATED_CONNECTORS_DISABLED,
  FEDERATED_TURN_REFUSED,
} from "./turn";

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
  homeBay = async () => ({ home_bay_id: "bay-home" });
  remoteBegin.mockReset().mockResolvedValue("remote-begin");
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

  it("fails closed on a malformed snapshot, local or remote", async () => {
    localSnapshot.mockResolvedValue({
      ...snap(LOCAL),
      other_members: undefined,
    });
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).rejects.toThrow(/malformed/);
    projectBay = "bay-b";
    remoteSnapshot.mockResolvedValue({
      ...snap("bay-b"),
      account_role: "admin",
    });
    await expect(
      owningBaySnapshot({ project_id: PROJECT, account_id: ACCOUNT }),
    ).rejects.toThrow(/malformed/);
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
    activeRun.mockRejectedValue(
      Error("Error: agent credential is expired, revoked, or invalid"),
    );
    expect(await federatedRunActivity(lease)).toBe("ended");
    for (const err of [
      Error("timeout"),
      Error("bay unreachable"),
      "x",
      "agent credential is expired, revoked, or invalid",
      Error("provider: agent credential is expired, revoked, or invalid"),
      Error("agent credential is expired, revoked, or invalid (retry)"),
      Error("Agent credential is expired, revoked, or invalid"),
    ]) {
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
  const SITE = "00000000-0000-4000-8000-0000000000aa";
  const ready = {
    identity: true,
    database: true,
    reference_time: true,
    signing: true,
  };
  const beat = { instance_id: "broker-instance-0001", site_id: SITE, ready };

  it("is closed until the broker is registered, the hub ready and a mint client set", async () => {
    const deps = federatedTurnDeps();
    settings = { federated_cli_connectors: "gcloud" };
    federatedBrokerRegistration.clear("expired");
    setFederatedBrokerMintClient({ getToken: jest.fn() });
    setFederatedHubReadiness(() => true);
    expect(await deps.gateOpen()).toBe(false);
    federatedBrokerRegistration.heartbeat(beat, "conn-1");
    expect(await deps.gateOpen()).toBe(true);
    expect(deps.site_id).toBe(SITE);
    setFederatedHubReadiness(() => false);
    expect(await deps.gateOpen()).toBe(false);
    setFederatedHubReadiness(() => true);
    setFederatedBrokerMintClient(undefined);
    expect(await deps.gateOpen()).toBe(false);
    setFederatedBrokerMintClient({ getToken: jest.fn() });
    settings = { federated_cli_connectors: "" };
    expect(await deps.gateOpen()).toBe(false);
    federatedBrokerRegistration.transportLost("conn-1");
    settings = { federated_cli_connectors: "gcloud" };
    expect(await deps.gateOpen()).toBe(false);
  });
});

describe("parseFederationSnapshot", () => {
  const good = snap(LOCAL);

  it("accepts exactly the owning bay's shape", () => {
    expect(parseFederationSnapshot(good, LOCAL)).toEqual(good);
    expect(
      parseFederationSnapshot(
        { ...good, account_role: null, approval_id: PROJECT },
        LOCAL,
      ),
    ).toBeDefined();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an extra key", { ...good, extra: 1 }],
    ["a missing key", { ...good, approval_id: undefined }],
    ["a negative count", { ...good, other_members: -1 }],
    ["a fractional count", { ...good, pending_invites: 0.5 }],
    ["a string count", { ...good, other_members: "0" }],
    ["a NaN revision", { ...good, users_revision: NaN }],
    ["an unknown role", { ...good, account_role: "admin" }],
    ["a bad approval id", { ...good, approval_id: "x" }],
    ["another bay", { ...good, owning_bay_id: "bay-z" }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseFederationSnapshot(value, LOCAL)).toThrow();
  });
});

describe("host-visible errors are fixed codes only", () => {
  const input = { account_id: ACCOUNT, host_id: HOST };
  const PLANTED = "planted-00000000-0000-4000-8000-000000000999 ya29.token";

  it("maps a failed home lookup and transport failures to unavailable", async () => {
    homeBay = async () => {
      throw Error(PLANTED);
    };
    for (const call of [
      beginFederatedConnectorTurn,
      endFederatedConnectorTurn,
    ]) {
      const err = await call(input).catch((e) => e);
      expect(err.message).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
    homeBay = async () => ({});
    expect(
      (await beginFederatedConnectorTurn(input).catch((e) => e)).message,
    ).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
    homeBay = async () => ({ home_bay_id: "bay-home" });
    for (const failure of [Error(PLANTED), Error("timeout"), "raw string"]) {
      remoteBegin.mockRejectedValueOnce(failure);
      const err = await beginFederatedConnectorTurn(input).catch((e) => e);
      expect(err.message).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
  });

  it("keeps the home bay's fixed codes exactly, also as inter-bay errors", async () => {
    for (const code of [
      `Error: ${FEDERATED_TURN_REFUSED}`,
      `Error: ${FEDERATED_CONNECTORS_DISABLED}`,
    ]) {
      remoteBegin.mockRejectedValueOnce(Error(code));
      expect(
        (await beginFederatedConnectorTurn(input).catch((e) => e)).message,
      ).toBe(code.slice("Error: ".length));
    }
    for (const near of [
      `Error: Error: ${FEDERATED_TURN_REFUSED}`,
      `error: ${FEDERATED_TURN_REFUSED}`,
      ` ${FEDERATED_TURN_REFUSED}`,
    ]) {
      remoteBegin.mockRejectedValueOnce(Error(near));
      expect(
        (await beginFederatedConnectorTurn(input).catch((e) => e)).message,
      ).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
    }
    for (const code of [
      FEDERATED_TURN_REFUSED,
      FEDERATED_CONNECTORS_DISABLED,
      FEDERATED_CONNECTOR_UNAVAILABLE,
    ]) {
      remoteBegin.mockRejectedValueOnce(Error(code));
      expect(
        (await beginFederatedConnectorTurn(input).catch((e) => e)).message,
      ).toBe(code);
    }
    remoteBegin.mockRejectedValueOnce(
      Error(`${FEDERATED_TURN_REFUSED} ${PLANTED}`),
    );
    expect(
      (await beginFederatedConnectorTurn(input).catch((e) => e)).message,
    ).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
  });
});
