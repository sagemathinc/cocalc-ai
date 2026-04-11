/** @jest-environment jsdom */

import immutable from "immutable";

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  Rendered: undefined,
  useTypedRedux: jest.fn(() => immutable.Map()),
  Store: class {},
  redux: {
    createStore: jest.fn(() => ({
      get: jest.fn(),
    })),
  },
}));

jest.mock("@cocalc/frontend/app-framework/is-mounted-hook", () => ({
  __esModule: true,
  default: () => ({ current: true }),
}));

jest.mock("@cocalc/frontend/users/actions", () => ({
  actions: {
    fetch_non_collaborator: jest.fn(),
  },
}));

describe("jupyter cursor profiles", () => {
  it("hydrates missing users instead of silently staying private", async () => {
    const { getProfile } = await import("../cursors");
    const { actions } = await import("@cocalc/frontend/users/actions");
    const accountId = "11111111-1111-4111-8111-111111111111";

    const profile = getProfile(accountId, immutable.Map());

    expect(actions.fetch_non_collaborator).toHaveBeenCalledWith(accountId);
    expect(profile).toEqual({
      color: "rgb(170,170,170)",
      name: "Private User",
    });
  });

  it("uses alias fallback and refreshes stale placeholder identities", async () => {
    const { getProfile } = await import("../cursors");
    const { actions } = await import("@cocalc/frontend/users/actions");
    const accountId = "22222222-2222-4222-8222-222222222222";

    const userMap = immutable.fromJS({
      [accountId]: {
        first_name: "Deleted",
        last_name: "User",
        name: "Remote Friend",
        profile: { color: "#123456" },
      },
    });

    const profile = getProfile(accountId, userMap);

    expect(actions.fetch_non_collaborator).toHaveBeenCalledWith(accountId);
    expect(profile).toEqual({
      color: "#123456",
      name: "Remote Friend",
    });
  });
});
