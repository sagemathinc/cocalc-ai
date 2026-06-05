import { EventEmitter } from "events";

const getSharedAccountDStream = jest.fn();
const resetSharedAccountDStreamCacheForTests = jest.fn();
const accountStore = {
  get: jest.fn((key: string) => (key === "account_id" ? "account-1" : null)),
};
const redux = {
  getStore: jest.fn(() => accountStore),
};
const conatClient = Object.assign(new EventEmitter(), {
  removeListener: EventEmitter.prototype.removeListener,
});
const webappClient = Object.assign(new EventEmitter(), {
  account_id: "account-1",
  conat_client: conatClient,
  is_signed_in: jest.fn(() => true),
  removeListener: EventEmitter.prototype.removeListener,
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux,
}));

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: (...args) => getSharedAccountDStream(...args),
  resetSharedAccountDStreamCacheForTests: (...args) =>
    resetSharedAccountDStreamCacheForTests(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

class FakeDStream<T> extends EventEmitter {
  private closed = false;

  isClosed = jest.fn(() => this.closed);

  close = jest.fn(() => {
    this.closed = true;
    this.emit("closed");
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("account lro summary feed reconnect handling", () => {
  beforeEach(() => {
    jest.resetModules();
    getSharedAccountDStream.mockReset();
    resetSharedAccountDStreamCacheForTests.mockReset();
    accountStore.get.mockImplementation((key: string) =>
      key === "account_id" ? "account-1" : null,
    );
    redux.getStore.mockReturnValue(accountStore);
    webappClient.account_id = "account-1";
    webappClient.is_signed_in.mockReturnValue(true);
    webappClient.removeAllListeners();
    conatClient.removeAllListeners();
  });

  it("requests a scoped reset after same-account sign-in so consumers re-bootstrap", async () => {
    const first = new FakeDStream();
    const second = new FakeDStream();
    getSharedAccountDStream
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const {
      resetAccountLroSummaryFeedForTests,
      subscribeAccountLroSummaryFeed,
    } = await import("./account-summary-feed");
    const reasons: string[] = [];
    const unsubscribe = subscribeAccountLroSummaryFeed((reason) => {
      reasons.push(reason);
    });
    try {
      await flush();
      reasons.length = 0;

      webappClient.emit("signed_in", { account_id: "account-1" });
      await flush();

      expect(reasons).toEqual(["reset"]);
      expect(getSharedAccountDStream).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      resetAccountLroSummaryFeedForTests();
    }
  });

  it("requests a scoped reset after conat reconnect so consumers refresh missed summaries", async () => {
    const first = new FakeDStream();
    const second = new FakeDStream();
    getSharedAccountDStream
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const {
      resetAccountLroSummaryFeedForTests,
      subscribeAccountLroSummaryFeed,
    } = await import("./account-summary-feed");
    const reasons: string[] = [];
    const unsubscribe = subscribeAccountLroSummaryFeed((reason) => {
      reasons.push(reason);
    });
    try {
      await flush();
      reasons.length = 0;

      conatClient.emit("connected");
      await flush();

      expect(reasons).toEqual(["reset"]);
      expect(getSharedAccountDStream).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      resetAccountLroSummaryFeedForTests();
    }
  });

  it("records lro summary feed diagnostics and history-gap repair", async () => {
    const feed = new FakeDStream();
    getSharedAccountDStream.mockResolvedValueOnce(feed);

    const {
      collectProjectionDiagnostics: collect,
      resetProjectionDiagnosticsForTests,
    } = await import("@cocalc/frontend/projection-diagnostics");
    resetProjectionDiagnosticsForTests();
    const {
      getAccountLroSummaries,
      resetAccountLroSummaryFeedForTests,
      subscribeAccountLroSummaryFeed,
    } = await import("./account-summary-feed");
    const reasons: string[] = [];
    const unsubscribe = subscribeAccountLroSummaryFeed((reason) => {
      reasons.push(reason);
    });
    try {
      await flush();

      expect(collect().consumers["lro-summary"].attach_count).toBe(1);

      feed.emit(
        "change",
        {
          type: "lro.summary",
          account_id: "account-1",
          ts: Date.now(),
          summary: {
            op_id: "op-1",
            kind: "project-start",
            status: "running",
            scope_type: "project",
            scope_id: "project-1",
            created_at: "2026-06-05T00:00:00.000Z",
            updated_at: "2026-06-05T00:00:00.000Z",
          },
        },
        12,
      );

      expect(getAccountLroSummaries()).toHaveLength(1);
      expect(collect().consumers["lro-summary"].last_event_type).toBe(
        "lro.summary",
      );
      expect(collect().consumers["lro-summary"].last_seq).toBe(12);

      reasons.length = 0;
      feed.emit("history-gap", {
        requested_start_seq: 3,
        effective_start_seq: 7,
      });

      expect(reasons).toEqual(["reset"]);
      const diagnostics = collect().consumers["lro-summary"];
      expect(diagnostics.history_gap_count).toBe(1);
      expect(diagnostics.last_repair_reason).toBe("history-gap");
      expect(diagnostics.last_repair_scope).toBe("active-scopes");
    } finally {
      unsubscribe();
      resetAccountLroSummaryFeedForTests();
    }
  });
});
