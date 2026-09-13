import { randomUUID } from "node:crypto";
import {
  getMonthlyCollection,
  proposeMonthlyCollection,
  reviewMonthlyCollection,
} from "./monthly-collection";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { hasCardPaymentMethod } from "./stripe/get-payment-methods";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "local",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/compute/funding/approvals", () => ({}));
jest.mock("@cocalc/server/compute/funding/backing", () => ({}));
jest.mock("./stripe/get-payment-methods", () => ({
  hasCardPaymentMethod: jest.fn(),
}));
jest.mock("@cocalc/database/settings", () => ({
  getServerSettings: async () => ({
    stripe_secret_key: "test",
    stripe_publishable_key: "test",
  }),
}));

const account_id = randomUUID();
const terms = {
  kind: "monthlyCollection",
  enabled: true,
  expected_version: 0,
  terms_version: 1,
} as const;
beforeEach(() => jest.clearAllMocks());
it("routes reads and proposals to the payer home without local database access", async () => {
  (resolveAccountHomeBay as jest.Mock).mockResolvedValue({
    home_bay_id: "remote",
  });
  const remote = {
    getMonthlyCollection: jest.fn().mockResolvedValue({ remote: true }),
    proposeMonthlyCollection: jest
      .fn()
      .mockResolvedValue({ intent_id: "remote" }),
  };
  (createInterBayAccountLocalClient as jest.Mock).mockReturnValue(remote);
  expect(await getMonthlyCollection({ account_id })).toEqual({ remote: true });
  const request = { account_id, operation_id: randomUUID(), terms };
  expect(await proposeMonthlyCollection(request)).toEqual({
    intent_id: "remote",
  });
  expect(remote.proposeMonthlyCollection).toHaveBeenCalledWith(request);
  expect(createInterBayAccountLocalClient).toHaveBeenCalledWith(
    expect.objectContaining({ dest_bay: "remote" }),
  );
  expect(getPool).not.toHaveBeenCalled();
});
it("requires a saved card for enabling but not for disabling", async () => {
  (getPool as jest.Mock).mockReturnValue({
    query: async () => ({ rows: [{ monthly_collection: null }] }),
  });
  (hasCardPaymentMethod as jest.Mock).mockResolvedValue(false);
  await expect(reviewMonthlyCollection(account_id, terms)).rejects.toThrow(
    "saved card",
  );
  await expect(
    reviewMonthlyCollection(account_id, { ...terms, enabled: false }),
  ).resolves.toBeUndefined();
  expect(hasCardPaymentMethod).toHaveBeenCalledTimes(1);
});
