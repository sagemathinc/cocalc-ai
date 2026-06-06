import { EventEmitter } from "events";
import { fromJS, Map as ImmutableMap } from "immutable";

import { accountFeedStreamName } from "../../../conat/hub/api/account-feed";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";
import { MAX_NOTIFICATION_INBOX_LIST_LIMIT } from "@cocalc/util/security-limits";

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: jest.fn(),
}));

jest.mock("../codex-turn-toast", () => ({
  showCodexTurnCompletionToastBestEffort: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => {
  const webappClient = Object.assign(new EventEmitter(), {
    is_signed_in: jest.fn(() => true),
    conat_client: Object.assign(new EventEmitter(), {
      hub: {
        notifications: {
          list: jest.fn(async () => []),
          counts: jest.fn(async () => ({
            total: 0,
            unread: 0,
            saved: 0,
            archived: 0,
            by_kind: {},
          })),
          markRead: jest.fn(async () => ({
            updated_count: 0,
            notification_ids: [],
          })),
          save: jest.fn(async () => ({
            updated_count: 0,
            notification_ids: [],
          })),
        },
      },
    }),
  });

  return { webapp_client: webappClient };
});

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MentionsActions } from "./actions";
import { showCodexTurnCompletionToastBestEffort } from "../codex-turn-toast";
import {
  collectProjectionDiagnostics,
  resetProjectionDiagnosticsForTests,
} from "@cocalc/frontend/projection-diagnostics";

const mockedWebappClient = webapp_client as unknown as EventEmitter & {
  is_signed_in: jest.Mock;
  conat_client: EventEmitter & {
    hub: {
      notifications: {
        list: jest.Mock;
        counts: jest.Mock;
        markRead: jest.Mock;
        save: jest.Mock;
      };
    };
  };
};
const getSharedAccountDStreamMock = getSharedAccountDStream as jest.Mock;
const showCodexTurnCompletionToastBestEffortMock =
  showCodexTurnCompletionToastBestEffort as jest.Mock;

class MockFeed extends EventEmitter {
  private closed = false;

  close() {
    this.closed = true;
    this.removeAllListeners();
  }

  isClosed() {
    return this.closed;
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MentionsActions realtime feed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProjectionDiagnosticsForTests();
    jest.useRealTimers();
    mockedWebappClient.is_signed_in.mockReturnValue(true);
    getSharedAccountDStreamMock.mockResolvedValue(new MockFeed());
    mockedWebappClient.conat_client.hub.notifications.list.mockResolvedValue(
      [],
    );
    mockedWebappClient.conat_client.hub.notifications.counts.mockResolvedValue({
      total: 0,
      unread: 0,
      saved: 0,
      archived: 0,
      by_kind: {},
    });
    mockedWebappClient.conat_client.hub.notifications.markRead.mockResolvedValue(
      {
        updated_count: 0,
        notification_ids: [],
      },
    );
    mockedWebappClient.conat_client.hub.notifications.save.mockResolvedValue({
      updated_count: 0,
      notification_ids: [],
    });
  });

  it("subscribes to the notification feed and applies delta events", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        if (name === "mentions") {
          return ImmutableMap({ mentions: ImmutableMap() });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    actions._init();
    await flush();

    expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
    expect(
      collectProjectionDiagnostics().consumers.notifications.attach_count,
    ).toBe(1);
    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledWith({ limit: MAX_NOTIFICATION_INBOX_LIST_LIMIT });

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "notification.upsert",
      account_id: "acct-1",
      reason: "projected_upsert",
      ts: Date.now(),
      notification: {
        notification_id: "n-1",
        kind: "mention",
        project_id: null,
        summary: {
          title: "Notice",
        },
        read_state: {
          read: false,
          saved: false,
        },
        created_at: "2026-04-05T00:00:00.000Z",
        updated_at: "2026-04-05T00:00:00.000Z",
      },
    });
    feed.emit("change", {
      type: "notification.counts",
      account_id: "acct-1",
      reason: "projected_upsert",
      ts: Date.now(),
      counts: {
        total: 1,
        unread: 1,
        saved: 0,
        archived: 0,
        by_kind: {
          mention: {
            total: 1,
            unread: 1,
            saved: 0,
            archived: 0,
          },
        },
      },
    });
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);

    feed.emit("history-gap", {
      requested_start_seq: 1,
      effective_start_seq: 5,
      oldest_retained_seq: 5,
      newest_retained_seq: 10,
    });
    await flush();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(2);
    const diagnostics = collectProjectionDiagnostics().consumers.notifications;
    expect(diagnostics.event_count).toBe(2);
    expect(diagnostics.last_event_type).toBe("notification.counts");
    expect(diagnostics.history_gap_count).toBe(1);
    expect(diagnostics.last_repair_reason).toBe("history-gap");
    expect(diagnostics.last_repair_scope).toBe("counts-and-inbox");
  });

  it("only shows codex completion toasts for new unread notification arrivals", async () => {
    let mentionsStore = ImmutableMap({ mentions: ImmutableMap() });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        if (name === "mentions") {
          return mentionsStore;
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((patch) => {
        if (patch.mentions != null) {
          mentionsStore = mentionsStore.merge(patch.mentions);
        }
      }),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    const notification = {
      notification_id: "n-codex",
      kind: "account_notice",
      project_id: null,
      summary: {
        title: "Codex finished",
        origin_label: "Codex",
        notice_type: "codex_turn_completion",
      },
      read_state: {
        read: false,
        saved: false,
      },
      created_at: "2026-04-05T00:00:00.000Z",
      updated_at: "2026-04-05T00:00:00.000Z",
    };

    feed.emit("change", {
      type: "notification.upsert",
      account_id: "acct-1",
      reason: "projected_upsert",
      ts: Date.now(),
      notification,
    });
    await flushMicrotasks();

    expect(showCodexTurnCompletionToastBestEffortMock).toHaveBeenCalledTimes(1);

    feed.emit("change", {
      type: "notification.upsert",
      account_id: "acct-1",
      reason: "read_state_updated",
      ts: Date.now(),
      notification: {
        ...notification,
        read_state: {
          read: true,
          saved: false,
        },
      },
    });
    await flushMicrotasks();

    feed.emit("change", {
      type: "notification.upsert",
      account_id: "acct-1",
      reason: "projected_upsert",
      ts: Date.now(),
      notification: {
        ...notification,
        notification_id: "n-already-read",
        read_state: {
          read: true,
          saved: false,
        },
      },
    });
    await flushMicrotasks();

    expect(showCodexTurnCompletionToastBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it("does not leave notifications loading forever after a transient refresh failure", async () => {
    jest.useFakeTimers();
    mockedWebappClient.conat_client.hub.notifications.list
      .mockRejectedValueOnce(
        new Error('once: "connected" not emitted before "closed"'),
      )
      .mockResolvedValueOnce([]);

    let mentionsStore = ImmutableMap({
      mentions: ImmutableMap(),
      loading: true,
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1", is_ready: true });
        }
        if (name === "mentions") {
          return mentionsStore;
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((patch) => {
        if (patch.mentions != null) {
          mentionsStore = mentionsStore.merge(patch.mentions);
        }
      }),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      actions._init();
      await flushMicrotasks();

      expect(
        mockedWebappClient.conat_client.hub.notifications.list,
      ).toHaveBeenCalledTimes(1);
      expect(mentionsStore.get("loading")).toBe(false);

      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(
        mockedWebappClient.conat_client.hub.notifications.list,
      ).toHaveBeenCalledTimes(2);
      expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
        account_id: "acct-1",
        name: accountFeedStreamName(),
        ephemeral: true,
        maxListeners: 100,
      });
    } finally {
      warnSpy.mockRestore();
      actions.destroy();
      jest.useRealTimers();
    }
  });

  it("waits for the account store is_ready event before bootstrapping", async () => {
    class MockAccountStore extends EventEmitter {
      private ready = false;

      get(key: string) {
        if (key === "account_id") {
          return this.ready ? "acct-1" : undefined;
        }
        if (key === "is_ready") {
          return this.ready;
        }
        return undefined;
      }

      setReady(): void {
        this.ready = true;
        this.emit("is_ready");
      }
    }

    const accountStore = new MockAccountStore();
    let reduxSubscriber: (() => void) | undefined;
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return accountStore as any;
        }
        if (name === "mentions") {
          return ImmutableMap({ mentions: ImmutableMap() });
        }
        return ImmutableMap();
      }),
      reduxStore: {
        subscribe: jest.fn((cb: () => void) => {
          reduxSubscriber = cb;
          return jest.fn();
        }),
      },
      _set_state: jest.fn(),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    actions._init();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).not.toHaveBeenCalled();
    expect(getSharedAccountDStreamMock).not.toHaveBeenCalled();
    expect(reduxSubscriber).toBeDefined();

    accountStore.setReady();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);
    expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
  });

  it("bootstraps when the account store appears already ready", async () => {
    class MockAccountStore extends EventEmitter {
      constructor(
        private readonly accountId: string | undefined,
        private readonly ready: boolean,
      ) {
        super();
      }

      get(key: string) {
        if (key === "account_id") {
          return this.accountId;
        }
        if (key === "is_ready") {
          return this.ready;
        }
        return undefined;
      }
    }

    let accountStore: MockAccountStore | undefined;
    let reduxSubscriber: (() => void) | undefined;
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return accountStore as any;
        }
        if (name === "mentions") {
          return ImmutableMap({ mentions: ImmutableMap() });
        }
        return ImmutableMap();
      }),
      reduxStore: {
        subscribe: jest.fn((cb: () => void) => {
          reduxSubscriber = cb;
          return jest.fn();
        }),
      },
      _set_state: jest.fn(),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    actions._init();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).not.toHaveBeenCalled();

    accountStore = new MockAccountStore("acct-2", true);
    reduxSubscriber?.();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);
    expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
      account_id: "acct-2",
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
  });

  it("does not re-refresh on unrelated redux updates once the same ready account store is attached", async () => {
    class MockAccountStore extends EventEmitter {
      get(key: string) {
        if (key === "account_id") {
          return "acct-3";
        }
        if (key === "is_ready") {
          return true;
        }
        return undefined;
      }
    }

    const accountStore = new MockAccountStore();
    let reduxSubscriber: (() => void) | undefined;
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return accountStore as any;
        }
        if (name === "mentions") {
          return ImmutableMap({ mentions: ImmutableMap() });
        }
        return ImmutableMap();
      }),
      reduxStore: {
        subscribe: jest.fn((cb: () => void) => {
          reduxSubscriber = cb;
          return jest.fn();
        }),
      },
      _set_state: jest.fn(),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    actions._init();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);

    reduxSubscriber?.();
    await flushMicrotasks();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps read-state ack pending until touched notification rows repair", async () => {
    jest.useFakeTimers();
    mockedWebappClient.conat_client.hub.notifications.markRead.mockResolvedValue(
      {
        updated_count: 1,
        notification_ids: ["n-1"],
      },
    );
    mockedWebappClient.conat_client.hub.notifications.list.mockResolvedValue([
      {
        notification_id: "n-1",
        kind: "mention",
        project_id: null,
        summary: {
          title: "Notice",
        },
        read_state: {
          read: true,
          saved: false,
        },
        created_at: new Date("2026-04-05T00:00:00.000Z"),
        updated_at: new Date("2026-04-05T00:00:00.000Z"),
      },
    ]);
    mockedWebappClient.conat_client.hub.notifications.counts.mockResolvedValue({
      total: 1,
      unread: 0,
      saved: 0,
      archived: 0,
      by_kind: {
        mention: {
          total: 1,
          unread: 0,
          saved: 0,
          archived: 0,
        },
      },
    });

    let mentionsStore = ImmutableMap({
      mentions: ImmutableMap({
        "n-1": fromJS({
          kind: "mention",
          notification_id: "n-1",
          project_id: null,
          target: "acct-1",
          time: new Date("2026-04-05T00:00:00.000Z"),
          title: "Notice",
          users: {
            "acct-1": {
              read: false,
              saved: false,
            },
          },
        }),
      }),
      unread_count: 1,
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        if (name === "mentions") {
          return mentionsStore;
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((patch) => {
        if (patch.mentions != null) {
          mentionsStore = mentionsStore.merge(patch.mentions);
        }
      }),
      removeActions: jest.fn(),
    } as any;
    const actions = new MentionsActions("mentions", redux);

    try {
      actions.markMany(["n-1"], "read");
      await flushMicrotasks();

      expect(
        mentionsStore.getIn(["mentions", "n-1", "users", "acct-1", "read"]),
      ).toBe(true);
      expect(
        mockedWebappClient.conat_client.hub.notifications.markRead,
      ).toHaveBeenCalledWith({
        notification_ids: ["n-1"],
        read: true,
      });
      expect(
        collectProjectionDiagnostics().consumers.notifications.last_ack_state,
      ).toBe("pending");

      await jest.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      expect(
        mockedWebappClient.conat_client.hub.notifications.list,
      ).toHaveBeenCalledWith({
        notification_id: "n-1",
        limit: 1,
      });
      const diagnostics =
        collectProjectionDiagnostics().consumers.notifications;
      expect(diagnostics.last_repair_reason).toBe("write-ack");
      expect(diagnostics.last_repair_scope).toEqual({
        kind: "notification-ids",
        notification_ids: ["n-1"],
      });
      expect(diagnostics.last_ack_state).toBe("converged");
      expect(diagnostics.pending_acks).toEqual({});
      expect(mentionsStore.get("unread_count")).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
