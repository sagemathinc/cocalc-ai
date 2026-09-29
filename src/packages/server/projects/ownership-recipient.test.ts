const query = jest.fn();
const allowance = jest.fn();
const usage = jest.fn();
const remoteUsage = jest.fn();
const directory = jest.fn();
const remote = jest.fn();
const remoteClient = jest.fn((_opts: any) => ({
  assertOwnershipRecipient: remote,
  getOwnershipUsageCount: remoteUsage,
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args) => allowance(...args),
}));
jest.mock("@cocalc/server/membership/effective-limits", () => ({
  getEffectiveMembershipUsageLimits: (resolution) => resolution,
}));
jest.mock("@cocalc/server/membership/project-usage", () => ({
  listUsageProjectsForAccount: (...args) => usage(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  listConfiguredBaysAuthoritative: async () => [
    { bay_id: "home" },
    { bay_id: "remote" },
  ],
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => directory(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (opts) => remoteClient(opts),
}));
import {
  assertOwnershipRecipient,
  assertOwnershipRecipientLocal,
} from "./ownership-recipient";

const opts = {
  account_id: "recipient",
  project_id: "project",
  current_usage_account_id: "owner",
  resulting_usage_account_id: "recipient",
};

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({
    rows: [{ deleted: false, banned: false, home_bay_id: "home" }],
  });
  allowance.mockResolvedValue({ max_projects: 3 });
  usage.mockResolvedValue([{ project_id: "existing-local" }]);
  remoteUsage.mockReset().mockResolvedValue(1);
  directory.mockResolvedValue({ home_bay_id: "home" });
});
it.each([{ deleted: true }, { banned: true }, undefined])(
  "rejects inactive recipients %j",
  async (row) => {
    query.mockResolvedValue({ rows: row ? [row] : [] });
    await expect(assertOwnershipRecipientLocal(opts)).rejects.toThrow(
      "active, non-banned",
    );
    expect(allowance).not.toHaveBeenCalled();
  },
);
it("checks project allowance without any admin exception", async () => {
  remoteUsage.mockResolvedValue(2);
  await expect(assertOwnershipRecipient(opts)).rejects.toThrow(
    "project limit reached",
  );
  expect(allowance).toHaveBeenCalledWith("recipient");
  expect(usage).toHaveBeenCalledWith("recipient", undefined, "home");
  expect(remoteUsage).toHaveBeenCalledWith({ account_id: "recipient" });
});
it("routes eligibility and allowance to the recipient's authoritative home", async () => {
  directory.mockResolvedValue({ home_bay_id: "remote" });
  await assertOwnershipRecipient(opts);
  expect(remoteClient).toHaveBeenCalledWith({
    client: "fabric",
    dest_bay: "remote",
  });
  expect(remote).toHaveBeenCalledWith(opts);
  expect(query).not.toHaveBeenCalled();
});
it("fails closed for missing directory entries or stale account homes", async () => {
  directory.mockResolvedValue(null);
  await expect(assertOwnershipRecipient(opts)).rejects.toThrow("not found");
  query.mockResolvedValue({ rows: [{ home_bay_id: "elsewhere" }] });
  await expect(assertOwnershipRecipientLocal(opts)).rejects.toThrow(
    "home changed",
  );
});

it.each([
  {
    current_usage_account_id: "recipient",
    resulting_usage_account_id: "recipient",
  },
  {
    current_usage_account_id: "third-party",
    resulting_usage_account_id: "third-party",
  },
])(
  "does not consume quota for zero attribution delta %j",
  async (attribution) => {
    allowance.mockResolvedValue({ max_projects: 0 });
    await assertOwnershipRecipientLocal({ ...opts, ...attribution });
    expect(query).toHaveBeenCalled();
    expect(allowance).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  },
);
it("fails closed when a project-owning bay cannot report usage", async () => {
  remoteUsage.mockRejectedValue(new Error("bay unavailable"));
  await expect(assertOwnershipRecipientLocal(opts)).rejects.toThrow(
    "bay unavailable",
  );
});
it("allows a positive delta when cluster-wide allowance remains", async () => {
  await expect(assertOwnershipRecipientLocal(opts)).resolves.toBeUndefined();
  expect(remoteUsage).toHaveBeenCalled();
});
