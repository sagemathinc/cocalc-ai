import { PurchasesClient } from "./purchases";

const setAccountState = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(() => ({
      setState: setAccountState,
    })),
  },
}));

describe("PurchasesClient", () => {
  beforeEach(() => {
    setAccountState.mockReset();
  });

  it("updates the account store when refreshing balance", async () => {
    const getBalance = jest.fn().mockResolvedValue("12.3400000000");
    const client = {
      conat_client: {
        hub: {
          purchases: { getBalance },
        },
      },
    };
    const purchases = new PurchasesClient(client as any);

    await expect(purchases.getBalance()).resolves.toBe("12.3400000000");

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(setAccountState).toHaveBeenCalledWith({
      balance: 12.34,
    });
  });
});
