import { EventEmitter } from "events";
import { Map as ImmutableMap } from "immutable";

import { accountFeedStreamName } from "../../../conat/hub/api/account-feed";

jest.mock("@cocalc/frontend/webapp-client", () => {
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
      dstream: jest.fn(async () => new MockFeed()),
    }),
  });

  return { webapp_client: webappClient };
});

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MentionsActions } from "./actions";

const mockedWebappClient = webapp_client as unknown as EventEmitter & {
  is_signed_in: jest.Mock;
  conat_client: EventEmitter & {
    dstream: jest.Mock;
    hub: {
      notifications: {
        list: jest.Mock;
        counts: jest.Mock;
      };
    };
  };
};

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
    jest.useRealTimers();
    mockedWebappClient.is_signed_in.mockReturnValue(true);
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
  });

  it("subscribes to the notification feed and refreshes on invalidate events", async () => {
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

    expect(mockedWebappClient.conat_client.dstream).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
    });
    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(1);

    const feed =
      await mockedWebappClient.conat_client.dstream.mock.results[0].value;
    feed.emit("change", {
      type: "notification.invalidate",
      account_id: "acct-1",
      reason: "projected_upsert",
      ts: Date.now(),
    });
    await flush();
    await flush();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(2);

    feed.emit("history-gap", {
      requested_start_seq: 1,
      effective_start_seq: 5,
      oldest_retained_seq: 5,
      newest_retained_seq: 10,
    });
    await flush();

    expect(
      mockedWebappClient.conat_client.hub.notifications.list,
    ).toHaveBeenCalledTimes(3);
  });

  it("retries bootstrap until the account store is ready", async () => {
    let accountReady = false;
    let scheduledRefresh: (() => void) | undefined;
    const setTimeoutMock = jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((cb: TimerHandler) => {
        scheduledRefresh = cb as () => void;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return accountReady
            ? ImmutableMap({ account_id: "acct-1" })
            : ImmutableMap();
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

    try {
      actions._init();
      await flushMicrotasks();

      expect(
        mockedWebappClient.conat_client.hub.notifications.list,
      ).not.toHaveBeenCalled();
      expect(mockedWebappClient.conat_client.dstream).not.toHaveBeenCalled();
      expect(scheduledRefresh).toBeDefined();

      accountReady = true;
      scheduledRefresh?.();
      await flushMicrotasks();

      expect(
        mockedWebappClient.conat_client.hub.notifications.list,
      ).toHaveBeenCalledTimes(1);
      expect(mockedWebappClient.conat_client.dstream).toHaveBeenCalledWith({
        account_id: "acct-1",
        name: accountFeedStreamName(),
        ephemeral: true,
      });
    } finally {
      setTimeoutMock.mockRestore();
    }
  });
});
