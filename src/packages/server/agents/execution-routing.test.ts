import { randomUUID } from "node:crypto";
import { personalControl } from "./personal";

const account = randomUUID();
const source = { project_id: randomUUID(), agent_id: randomUUID() };
const target = { project_id: randomUUID(), agent_id: randomUUID() };
const run = randomUUID();
const network = randomUUID();
let owner = "home";
let banned = false;
const localPrincipal = jest.fn();
const localExecution = jest.fn();
const remotePrincipal = jest.fn();
const remoteExecution = jest.fn();

jest.mock("./store", () => ({ agentStore: () => ({}) }));
jest.mock("./personal-store", () => ({
  PersonalAgentStore: jest
    .fn()
    .mockImplementation(
      (
        _db,
        _identity,
        principal,
        _authority,
        _deleted,
        executionPrincipal,
      ) => ({
        assertHome: async () => {},
        checkNetwork: async (
          _account,
          _network,
          source,
          run_id,
          _target,
          forExecution,
        ) => ({
          principal: await (forExecution ? executionPrincipal : principal)(
            source,
            run_id,
          ),
        }),
      }),
    ),
}));
jest.mock("./api", () => ({ getIdentity: jest.fn() }));
jest.mock("./rpc", () => ({
  agentRpcControl: {
    principal: (...args) => localPrincipal(...args),
    executionPrincipal: (...args) => localExecution(...args),
  },
}));
jest.mock("@cocalc/conat/inter-bay/agent-rpc", () => ({
  createAgentRpcControlClient: () => ({
    principal: (...args) => remotePrincipal(...args),
    executionPrincipal: (...args) => remoteExecution(...args),
  }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: "home" }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({ bay_id: owner, epoch: 7 }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => banned,
}));

beforeEach(() => {
  owner = "home";
  banned = false;
  for (const fn of [
    localPrincipal,
    localExecution,
    remotePrincipal,
    remoteExecution,
  ])
    fn.mockReset().mockResolvedValue({
      account_id: account,
      personal_messaging: true,
    });
});

const check = (action: "checkNetwork" | "checkExecutionNetwork") =>
  personalControl({
    account_id: account,
    home_bay_id: "home",
    request: {
      action,
      options: { source, target, run_id: run, agent_network_id: network },
    },
  });

test.each(["home", "remote"])(
  "execution provenance routes to %s source owner, not live-run authentication",
  async (bay) => {
    owner = bay;
    await expect(check("checkExecutionNetwork")).resolves.toEqual({
      principal: account,
    });
    expect(
      bay === "home" ? localExecution : remoteExecution,
    ).toHaveBeenCalledWith({
      source,
      run_id: run,
      project_id: source.project_id,
      route: { bay_id: bay, epoch: 7 },
    });
    expect(localPrincipal).not.toHaveBeenCalled();
    expect(remotePrincipal).not.toHaveBeenCalled();
    expect(
      bay === "home" ? remoteExecution : localExecution,
    ).not.toHaveBeenCalled();
  },
);

test.each(["home", "remote"])(
  "new send authentication still uses live principal on %s",
  async (bay) => {
    owner = bay;
    await check("checkNetwork");
    expect(
      bay === "home" ? localPrincipal : remotePrincipal,
    ).toHaveBeenCalledTimes(1);
    expect(localExecution).not.toHaveBeenCalled();
    expect(remoteExecution).not.toHaveBeenCalled();
  },
);

test("account-home ban rejects execution before looking up source provenance", async () => {
  banned = true;
  await expect(check("checkExecutionNetwork")).resolves.toEqual({
    denied: "account_disabled",
  });
  expect(localExecution).not.toHaveBeenCalled();
});

test("an old source bay without the execution method does not fall back to active-run checks", async () => {
  owner = "remote";
  remoteExecution.mockRejectedValueOnce(Error("unknown method"));
  await expect(check("checkExecutionNetwork")).rejects.toThrow(
    "unknown method",
  );
  expect(remotePrincipal).not.toHaveBeenCalled();
});
