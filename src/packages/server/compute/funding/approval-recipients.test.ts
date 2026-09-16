import getPool from "@cocalc/database/pool";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  checkFundingApprovalRecipientsOnHome,
  prepareFundingApprovalRecipients,
} from "./approval-recipients";
import type { FundingApprovalReview } from "./approval-review";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "local",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(),
}));
const payer = "11111111-1111-4111-8111-111111111111";
const student = "22222222-2222-4222-8222-222222222222";
const review = {
  payer: { account_id: payer, home_bay_id: "old" },
  recipients: [{ account_id: student, home_bay_id: "old" }],
} as FundingApprovalReview;
const query = jest.fn();
const remote = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (getPool as jest.Mock).mockReturnValue({ query });
  (getClusterAccountsByIds as jest.Mock).mockResolvedValue([
    { account_id: payer, home_bay_id: "local" },
    { account_id: student, home_bay_id: "remote" },
  ]);
  query.mockResolvedValue({
    rows: [{ account_id: payer, home_bay_id: "local" }],
  });
  remote.mockResolvedValue(undefined);
  (createInterBayAccountLocalClient as jest.Mock).mockReturnValue({
    computeFundingCheckApprovalRecipients: remote,
  });
});
it("routes to current homes, not stored review homes, and holds local row checks in the commit", async () => {
  const check = await prepareFundingApprovalRecipients(review, true);
  expect(remote).toHaveBeenCalledWith({
    account_ids: [student],
    home_bay_id: "remote",
    require_active: true,
  });
  const db = {
    query: jest.fn().mockResolvedValue({
      rows: [{ account_id: payer, home_bay_id: "local" }],
    }),
  };
  expect(await check(db as any)).toEqual({
    [payer]: "local",
    [student]: "remote",
  });
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE"), [
    [payer],
  ]);
});
it.each([{ banned: true }, { deleted: true }, { home_bay_id: "moved" }])(
  "rejects recipient state changed since proposal: %j",
  async (state) => {
    query.mockResolvedValue({
      rows: [{ account_id: student, home_bay_id: "local", ...state }],
    });
    await expect(
      checkFundingApprovalRecipientsOnHome({
        account_ids: [student],
        home_bay_id: "local",
        require_active: true,
      }),
    ).rejects.toThrow("unavailable");
  },
);
it("rechecks local sanctions after preflight and rejects vanished accounts", async () => {
  const check = await prepareFundingApprovalRecipients(review, true);
  for (const rows of [
    [],
    [{ account_id: payer, home_bay_id: "local", banned: true }],
  ])
    await expect(
      check({ query: jest.fn().mockResolvedValue({ rows }) } as any),
    ).rejects.toThrow("unavailable");
});
it("does not fall back when a remote check fails", async () => {
  remote.mockRejectedValue(new Error("recipient deleted"));
  await expect(prepareFundingApprovalRecipients(review, true)).rejects.toThrow(
    "deleted",
  );
});
it("rejects stale preflight, wrong listener bay and missing directory homes", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(0);
  try {
    const check = await prepareFundingApprovalRecipients(review, true);
    clock.mockReturnValue(30_001);
    await expect(check({ query } as any)).rejects.toThrow("expired");
  } finally {
    clock.mockRestore();
  }
  await expect(
    checkFundingApprovalRecipientsOnHome({
      account_ids: [student],
      home_bay_id: "remote",
      require_active: true,
    }),
  ).rejects.toThrow("wrong home");
  (getClusterAccountsByIds as jest.Mock).mockResolvedValue([]);
  await expect(prepareFundingApprovalRecipients(review, true)).rejects.toThrow(
    "unavailable",
  );
});
it("allows a sanctions-affected recipient in a reduction, never new authorization", async () => {
  query.mockResolvedValue({
    rows: [
      {
        account_id: student,
        home_bay_id: "local",
        deleted: true,
        banned: true,
      },
    ],
  });
  await expect(
    checkFundingApprovalRecipientsOnHome({
      account_ids: [student],
      home_bay_id: "local",
      require_active: false,
    }),
  ).resolves.toBeUndefined();
});
