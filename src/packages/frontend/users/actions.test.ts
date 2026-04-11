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
  it("hydrates an existing placeholder collaborator row", async () => {
    const { webapp_client } = await import("../webapp-client");
    const { store } = await import("./store");
    const { actions } = await import("./actions");

    (webapp_client.users_client.getNames as jest.Mock).mockResolvedValue({
      "acct-1": {
        first_name: "Remote",
        last_name: "Friend",
        profile: { image: "remote.png" },
      },
    });
    (store.get as jest.Mock).mockReturnValue(
      fromJS({
        "acct-1": {
          first_name: "Deleted",
          last_name: "User",
          collaborator: true,
        },
      }),
    );

    await actions.fetch_non_collaborator("acct-1");

    expect(webapp_client.users_client.getNames).toHaveBeenCalledWith([
      "acct-1",
    ]);
    expect(
      (actions.setState as jest.Mock).mock.calls[0][0].user_map.toJS(),
    ).toEqual({
      "acct-1": {
        account_id: "acct-1",
        collaborator: true,
        first_name: "Remote",
        last_name: "Friend",
        profile: { image: "remote.png" },
      },
    });
  });
});
