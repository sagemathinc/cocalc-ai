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
});
