/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const createGraph = jest.fn(async () => undefined);

jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  withAccountRehomeWriteFence: async ({ fn }: any) =>
    fn({ query: async () => ({ rows: [] }) }),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: (...args: any[]) =>
    (createGraph as any)(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

import { receiveComputeResourceNotice } from "./compute-resource";

const notice = {
  id: "11111111-1111-4111-8111-111111111111",
  account_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "33333333-3333-4333-8333-333333333333",
  resource_kind: "vm" as const,
  resource_name: "gpu-box",
  action: "stop" as const,
  phase: "completed" as const,
  observed_at: "2026-11-05T12:00:00.000Z",
};

describe("compute resource notices", () => {
  beforeEach(() => createGraph.mockClear());

  it("explains a Nebius Spot price stop (#684)", async () => {
    await receiveComputeResourceNotice({
      ...notice,
      reason: "spot_price_above_max",
    });
    const body = (createGraph.mock.calls[0] as any)[0].input.payload_json
      .body_markdown;
    expect(body).toContain("spot price rose above this Spot VM's price cap");
    expect(body).toContain("Standard");
  });

  it("keeps the plain stop text without a reason", async () => {
    await receiveComputeResourceNotice(notice);
    const body = (createGraph.mock.calls[0] as any)[0].input.payload_json
      .body_markdown;
    expect(body).not.toContain("spot price");
  });

  it("rejects unknown reasons and reasons on other actions", async () => {
    for (const bad of [
      { ...notice, reason: "other" },
      { ...notice, action: "delete", reason: "spot_price_above_max" },
      {
        ...notice,
        resource_kind: "volume",
        action: "delete",
        reason: "spot_price_above_max",
      },
    ]) {
      await expect(receiveComputeResourceNotice(bad as any)).rejects.toThrow(
        "Invalid resource notice",
      );
    }
    expect(createGraph).not.toHaveBeenCalled();
  });
});
