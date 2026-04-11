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

    const profile = getProfile("acct-missing", immutable.Map());

    expect(actions.fetch_non_collaborator).toHaveBeenCalledWith("acct-missing");
    expect(profile).toEqual({
      color: "rgb(170,170,170)",
      name: "Private User",
    });
  });

  it("uses alias fallback and refreshes stale placeholder identities", async () => {
    const { getProfile } = await import("../cursors");
    const { actions } = await import("@cocalc/frontend/users/actions");

    const userMap = immutable.fromJS({
      "acct-remote": {
        first_name: "Deleted",
        last_name: "User",
        name: "Remote Friend",
        profile: { color: "#123456" },
      },
    });

    const profile = getProfile("acct-remote", userMap);

    expect(actions.fetch_non_collaborator).toHaveBeenCalledWith("acct-remote");
    expect(profile).toEqual({
      color: "#123456",
      name: "Remote Friend",
    });
  });
});
