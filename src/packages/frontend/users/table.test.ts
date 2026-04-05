/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";

jest.mock("../app-framework", () => {
  class Table {}
  return {
    Table,
    redux: {
      getStore: jest.fn((name: string) => {
        if (name === "page") {
          return {
            get: jest.fn(() => undefined),
          };
        }
        if (name === "account") {
          return {
            get: jest.fn(() => undefined),
            on: jest.fn(),
            removeListener: jest.fn(),
          };
        }
        return undefined;
      }),
      createTable: jest.fn(() => ({
        _table: {
          on: jest.fn(),
        },
      })),
      removeTable: jest.fn(),
      reduxStore: {
        subscribe: jest.fn(() => jest.fn()),
      },
    },
  };
});

jest.mock("../webapp-client", () => ({
  webapp_client: {
    is_signed_in: jest.fn(() => false),
    on: jest.fn(),
    conat_client: {
      on: jest.fn(),
      dstream: jest.fn(),
    },
  },
}));

jest.mock("./actions", () => ({
  actions: {
    setState: jest.fn(),
  },
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn(() => undefined),
  },
}));

describe("users table helpers", () => {
  it("builds collaborator rows with Date last_active and collaborator marker", async () => {
    const { buildCollaboratorRecord } = await import("./table");

    const record = buildCollaboratorRecord({
      account_id: "acct-1",
      first_name: "Alice",
      last_name: "Anderson",
      name: "alice",
      last_active: "2026-04-05T00:00:00.000Z",
      profile: { image: "alice.png" },
      common_project_count: 2,
      updated_at: "2026-04-05T00:01:00.000Z",
    });

    expect(record.get("account_id")).toBe("acct-1");
    expect(record.get("collaborator")).toBe(true);
    expect(record.get("last_active")).toEqual(
      new Date("2026-04-05T00:00:00.000Z"),
    );
  });

  it("merges full snapshot rows without forgetting non-collaborators", async () => {
    const { mergeUsersSnapshot } = await import("./table");
    const { store } = await import("./store");

    (store.get as jest.Mock).mockReturnValue(
      fromJS({
        "acct-old-collab": {
          first_name: "Old",
          last_name: "Collab",
          collaborator: true,
        },
        "acct-non-collab": {
          first_name: "Fetched",
          last_name: "User",
        },
      }),
    );

    const merged = mergeUsersSnapshot(
      fromJS({
        "acct-new-collab": {
          first_name: "New",
          last_name: "Collab",
        },
      }) as Map<string, Map<string, any>>,
    );

    expect(merged.getIn(["acct-old-collab", "collaborator"])).toBe(false);
    expect(merged.getIn(["acct-non-collab", "first_name"])).toBe("Fetched");
    expect(merged.getIn(["acct-new-collab", "collaborator"])).toBe(true);
  });
});
