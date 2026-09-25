import { randomUUID } from "node:crypto";

const mockQuery = jest.fn();
const mockAccount = jest.fn();
const mockAccounts = jest.fn();
jest.mock("./usage-projection", () => ({
  getCourseFundingUsageProjection: async () => new Map(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "payer-home",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => true,
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => mockAccount(...args),
  getClusterAccountsByIds: (...args) => mockAccounts(...args),
}));

import { listCourseFundingSourcesOnBay } from "./sources";

const beneficiary = randomUUID();
const payer = randomUUID();
const now = new Date("2026-09-12T10:00:00.000Z");
const source = {
  pool_id: randomUUID(),
  grant_id: randomUUID(),
  payer_account_id: payer,
  label: "Calculus",
  lane: "prepaid",
  state: "active",
  pool_state: "active",
  available_for_new_resources: true,
  authorized_usd: "50",
  spent_usd: "2",
  reserved_usd: "1",
  released_usd: "0",
  starts_at: now.toISOString(),
  ends_at: "2026-10-12T10:00:00.000Z",
};
const request = {
  beneficiary_account_id: beneficiary,
  beneficiary_home_bay_id: "student-home",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockAccount.mockResolvedValue({
    account_id: beneficiary,
    home_bay_id: "student-home",
  });
  mockAccounts.mockResolvedValue([
    { account_id: payer, home_bay_id: "payer-home" },
  ]);
  mockQuery.mockResolvedValue({ rows: [{ as_of: now, sources: [source] }] });
});

it("projects only the requested beneficiary and explicitly whitelists budget fields", async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        as_of: now,
        sources: [
          {
            ...source,
            other_students: [randomUUID()],
            hold_id: "private-hold",
            pool_total_usd: "10000",
          },
        ],
      },
    ],
  });
  expect(await listCourseFundingSourcesOnBay(request)).toEqual({
    as_of: now.toISOString(),
    sources: [source],
    payer_home_bay_ids: ["payer-home"],
  });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("g.beneficiary_account_id=$1"),
    [beneficiary, 1001, false],
  );
  expect(mockAccounts).toHaveBeenCalledWith([payer]);
});

it("omits stale local copies after payer rehome while advertising required discovery coverage", async () => {
  mockAccounts.mockResolvedValue([
    { account_id: payer, home_bay_id: "successor-home" },
  ]);
  expect(await listCourseFundingSourcesOnBay(request)).toEqual({
    as_of: now.toISOString(),
    sources: [],
    payer_home_bay_ids: ["successor-home"],
  });
});

it.each([{ accounts: [] }, { accounts: [{ account_id: payer }] }])(
  "fails closed when payer authority is unresolved: %j",
  async ({ accounts }) => {
    mockAccounts.mockResolvedValue(accounts);
    await expect(listCourseFundingSourcesOnBay(request)).rejects.toThrow(
      "payer's current home bay could not be resolved",
    );
  },
);

it("rejects discovery initiated from an obsolete beneficiary home", async () => {
  mockAccount.mockResolvedValue({
    account_id: beneficiary,
    home_bay_id: "new-student-home",
  });
  await expect(listCourseFundingSourcesOnBay(request)).rejects.toThrow(
    "beneficiary's current home bay",
  );
  expect(mockQuery).not.toHaveBeenCalled();
});

it("does not return partial results when the payer directory is unavailable", async () => {
  mockAccounts.mockRejectedValue(Error("directory offline"));
  await expect(listCourseFundingSourcesOnBay(request)).rejects.toThrow(
    "directory offline",
  );
});

it("rejects truncated discovery rather than silently dropping grants", async () => {
  mockQuery.mockResolvedValue({
    rows: [{ as_of: now, sources: Array(1001).fill(source) }],
  });
  await expect(listCourseFundingSourcesOnBay(request)).rejects.toThrow(
    "complete bounded discovery",
  );
});

it("returns an empty but timestamped authoritative projection", async () => {
  mockQuery.mockResolvedValue({ rows: [{ as_of: now, sources: [] }] });
  mockAccounts.mockResolvedValue([]);
  expect(await listCourseFundingSourcesOnBay(request)).toEqual({
    as_of: now.toISOString(),
    sources: [],
    payer_home_bay_ids: [],
  });
});
