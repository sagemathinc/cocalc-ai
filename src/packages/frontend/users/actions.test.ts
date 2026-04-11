/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

jest.mock("../app-framework", () => {
  class Actions {
    setState = jest.fn();
  }
  return {
    Actions,
    redux: {
      createActions: jest.fn((_name: string, ActionsClass: any) => {
        return new ActionsClass();
      }),
    },
  };
});

jest.mock("../webapp-client", () => ({
  webapp_client: {
    users_client: {
      getNames: jest.fn(),
    },
  },
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
  },
}));

describe("UsersActions.fetch_non_collaborator", () => {
  beforeEach(async () => {
    const { webapp_client } = await import("../webapp-client");
    const { actions } = await import("./actions");
    (webapp_client.users_client.getNames as jest.Mock).mockReset();
    (actions.setState as jest.Mock).mockReset();
  });

  it("hydrates an existing placeholder collaborator row", async () => {
    const { webapp_client } = await import("../webapp-client");
    const { store } = await import("./store");
    const { actions } = await import("./actions");
    const remoteAccountId = "11111111-1111-4111-8111-111111111111";

    (webapp_client.users_client.getNames as jest.Mock).mockResolvedValue({
      [remoteAccountId]: {
        first_name: "Remote",
        last_name: "Friend",
        profile: { image: "remote.png" },
      },
    });
    (store.get as jest.Mock).mockReturnValue(
      fromJS({
        [remoteAccountId]: {
          first_name: "Deleted",
          last_name: "User",
          collaborator: true,
        },
      }),
    );

    await actions.fetch_non_collaborator(remoteAccountId);

    expect(webapp_client.users_client.getNames).toHaveBeenCalledWith([
      remoteAccountId,
    ]);
    expect(
      (actions.setState as jest.Mock).mock.calls[0][0].user_map.toJS(),
    ).toEqual({
      [remoteAccountId]: {
        account_id: remoteAccountId,
        collaborator: true,
        first_name: "Remote",
        last_name: "Friend",
        profile: { image: "remote.png" },
      },
    });
  });

  it("ignores non-uuid ids instead of querying for names", async () => {
    const { webapp_client } = await import("../webapp-client");
    const { actions } = await import("./actions");

    await actions.fetch_non_collaborator("un7nePsSiK");

    expect(webapp_client.users_client.getNames).not.toHaveBeenCalled();
    expect(actions.setState).not.toHaveBeenCalled();
  });
});
