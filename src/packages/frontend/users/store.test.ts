/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("../app-framework", () => {
  class Store {
    getIn() {
      return undefined;
    }
    get() {
      return undefined;
    }
  }
  return {
    Store,
    redux: {
      createStore: jest.fn(
        (_name: string, StoreClass: any) => new StoreClass(),
      ),
      getStore: jest.fn(),
    },
  };
});

jest.mock("../webapp-client", () => ({
  webapp_client: {
    async_query: jest.fn(),
  },
}));

jest.mock("./actions", () => ({ actions: {} }));

describe("UsersStore.get_image", () => {
  it("never queries account_profiles for a sender that is not an account", async () => {
    const { webapp_client } = await import("../webapp-client");
    const { store } = await import("./store");
    const query = webapp_client.async_query as jest.Mock;
    query.mockReset();
    // The agent harness posts chat messages as "acp-harness"; querying it
    // made postgres reject the id ("invalid input syntax for type uuid").
    await expect(store.get_image("acp-harness")).resolves.toBeUndefined();
    await expect(store.get_color("acp-harness")).resolves.toEqual(
      expect.any(String),
    );
    expect(query).not.toHaveBeenCalled();

    const account_id = "8ee6d7b0-bbe2-443a-bf3a-263a30466959";
    query.mockResolvedValue({
      query: { account_profiles: { profile: { image: "img.png" } } },
    });
    await expect(store.get_image(account_id)).resolves.toBe("img.png");
    expect(query).toHaveBeenCalledWith({
      query: { account_profiles: { account_id, profile: null } },
    });
  });
});
