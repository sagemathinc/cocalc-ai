/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";
import { EventEmitter } from "events";

const getSharedAccountDStream = jest.fn();
let signedIn = false;
let accountId: string | undefined;
let userMap = Map<string, any>();

class MockFeed extends EventEmitter {
  private closed = false;

  isClosed() {
    return this.closed;
  }

  close() {
    this.closed = true;
    this.emit("closed");
  }
}

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
            get: jest.fn((key: string) => {
              if (key === "account_id") return accountId;
              if (key === "is_ready") return accountId != null;
              return undefined;
            }),
            on: jest.fn(),
            removeListener: jest.fn(),
          };
        }
        return undefined;
      }),
      createTable: jest.fn(() => ({
        _table: {
          get_state: jest.fn(() => "connected"),
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
    is_signed_in: jest.fn(() => signedIn),
    on: jest.fn(),
    conat_client: {
      on: jest.fn(),
      dstream: jest.fn(),
    },
  },
}));

jest.mock("./actions", () => ({
  actions: {
    setState: jest.fn((patch) => {
      if (patch.user_map != null) {
        userMap = patch.user_map;
      }
    }),
  },
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn((key: string) => {
      if (key === "user_map") return userMap;
      return undefined;
    }),
  },
}));

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: (...args: any[]) => getSharedAccountDStream(...args),
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("users table helpers", () => {
  beforeEach(async () => {
    jest.resetModules();
    getSharedAccountDStream.mockReset();
    signedIn = false;
    accountId = undefined;
    userMap = Map<string, any>();
    const { resetProjectionDiagnosticsForTests } =
      await import("@cocalc/frontend/projection-diagnostics");
    resetProjectionDiagnosticsForTests();
  });

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

  it("records collaborator feed diagnostics and repairs on history gaps", async () => {
    signedIn = true;
    accountId = "acct-1";
    const feed = new MockFeed();
    getSharedAccountDStream.mockResolvedValue(feed);

    await import("./table");
    await flush();

    const { collectProjectionDiagnostics } =
      await import("@cocalc/frontend/projection-diagnostics");
    expect(collectProjectionDiagnostics().consumers.users.attach_count).toBe(1);

    feed.emit(
      "change",
      {
        type: "collaborator.upsert",
        account_id: "acct-1",
        ts: Date.now(),
        collaborator: {
          account_id: "acct-collab",
          first_name: "Ada",
          last_name: "Lovelace",
          name: "Ada Lovelace",
          profile: null,
          last_active: "2026-06-05T00:00:00.000Z",
          common_project_count: 1,
          updated_at: "2026-06-05T00:00:00.000Z",
        },
      },
      19,
    );

    expect(userMap.getIn(["acct-collab", "collaborator"])).toBe(true);
    expect(collectProjectionDiagnostics().consumers.users.last_event_type).toBe(
      "collaborator.upsert",
    );
    expect(collectProjectionDiagnostics().consumers.users.last_seq).toBe(19);

    feed.emit("history-gap", {
      requested_start_seq: 2,
      effective_start_seq: 5,
    });

    const diagnostics = collectProjectionDiagnostics().consumers.users;
    expect(diagnostics.history_gap_count).toBe(1);
    expect(diagnostics.last_repair_reason).toBe("snapshot-refresh");
    expect(diagnostics.last_repair_scope).toBe("collaborators");
  });
});
