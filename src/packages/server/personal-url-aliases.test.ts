import {
  lookupPersonalUrlAlias,
  personalUrlAliasHomeControl,
} from "./personal-url-aliases";

const owner_account_id = "22222222-2222-4222-8222-222222222222";
const project_id = "33333333-3333-4333-8333-333333333333";
const agent_id = "44444444-4444-4444-8444-444444444444";
const home = jest.fn();
const query = jest.fn();
const fence = jest.fn();
const remote = jest.fn();
const remoteClient = jest.fn();
const fabric = {};

jest.mock("./bay-config", () => ({ getConfiguredBayId: () => "bay-a" }));
jest.mock("./bay-directory", () => ({
  resolveAccountHomeBay: (...args) => home(...args),
}));
jest.mock("./inter-bay/fabric", () => ({
  getInterBayFabricClient: () => fabric,
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: (...args) => fence(...args),
}));
jest.mock("@cocalc/conat/inter-bay/personal-url-aliases", () => ({
  createInterBayPersonalUrlAliasesClient: (...args) => remoteClient(...args),
}));

beforeEach(() => {
  jest.resetAllMocks();
  home.mockResolvedValue({ home_bay_id: "bay-a" });
  fence.mockImplementation(({ fn }) => fn({ query }));
  query.mockResolvedValueOnce({ rows: [{ aliases: {} }] });
  remoteClient.mockReturnValue({ lookup: remote });
});

test("reads a single exact alias inside the owner's rehome fence", async () => {
  query.mockResolvedValueOnce({ rows: [{ project_id, agent_id }] });
  await expect(
    lookupPersonalUrlAlias({
      owner_account_id,
      kind: "agents",
      alias: "AGENT-16",
    }),
  ).resolves.toEqual({ kind: "agent", project_id, agent_id });
  expect(fence).toHaveBeenCalledWith(
    expect.objectContaining({ account_id: owner_account_id }),
  );
  expect(query.mock.calls[1][1]).toEqual([owner_account_id, "agent-16"]);
  expect(query.mock.calls[1][0]).toContain("retired_at IS NULL");
});

test("nonlocal alias owners are routed to their home, never the viewer database", async () => {
  home.mockResolvedValue({ home_bay_id: "bay-c" });
  remote.mockResolvedValue({
    kind: "artifact",
    project_id,
    entry_id: "a".repeat(64),
  });
  const result = await lookupPersonalUrlAlias({
    owner_account_id,
    kind: "artifacts",
    alias: "primes",
  });
  expect(remoteClient).toHaveBeenCalledWith(fabric, "bay-c");
  expect(remote).toHaveBeenCalledWith({
    owner_account_id,
    home_bay_id: "bay-c",
    kind: "artifacts",
    alias: "primes",
  });
  expect(result).toMatchObject({ kind: "artifact", project_id });
  expect(query).not.toHaveBeenCalled();
});

test("an old home rejects stale routing rather than reading imported state", async () => {
  home.mockResolvedValue({ home_bay_id: "bay-c" });
  await expect(
    personalUrlAliasHomeControl.lookup({
      owner_account_id,
      home_bay_id: "bay-a",
      kind: "agents",
      alias: "agent-16",
    }),
  ).rejects.toThrow("Stale account-home route");
  expect(fence).not.toHaveBeenCalled();
});

test("rehome freeze prevents alias reads", async () => {
  fence.mockRejectedValue(Error("rehome frozen"));
  await expect(
    lookupPersonalUrlAlias({
      owner_account_id,
      kind: "agents",
      alias: "agent-16",
    }),
  ).rejects.toThrow("rehome frozen");
  expect(query).not.toHaveBeenCalled();
});

test("banned or deleted owners cannot resolve retained aliases", async () => {
  query.mockReset().mockResolvedValue({ rows: [] });
  expect(
    await lookupPersonalUrlAlias({
      owner_account_id,
      kind: "agents",
      alias: "agent-16",
    }),
  ).toBeNull();
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toContain("banned IS NOT TRUE");
});

test("ambiguous chat labels fail closed", async () => {
  query.mockResolvedValueOnce({
    rows: [
      { project_id, kind: "agent", resource_id: agent_id },
      { project_id, kind: "conversation", resource_id: "other" },
    ],
  });
  expect(
    await lookupPersonalUrlAlias({
      owner_account_id,
      kind: "chats",
      alias: "chat1",
    }),
  ).toBeNull();
});

test("transport errors propagate without falling back to local state", async () => {
  home.mockResolvedValue({ home_bay_id: "bay-c" });
  remote.mockRejectedValue(Error("timeout"));
  await expect(
    lookupPersonalUrlAlias({
      owner_account_id,
      kind: "agents",
      alias: "agent-16",
    }),
  ).rejects.toThrow("timeout");
  expect(query).not.toHaveBeenCalled();
});
