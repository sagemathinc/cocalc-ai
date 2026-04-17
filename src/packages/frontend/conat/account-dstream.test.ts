import { EventEmitter } from "events";

const dstreamMock = jest.fn();
const webappClient = Object.assign(new EventEmitter(), {
  conat_client: {
    dstream: dstreamMock,
  },
  removeListener: EventEmitter.prototype.removeListener,
});

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

class FakeDStream extends EventEmitter {
  close = jest.fn(() => {
    this.emit("closed");
  });
}

describe("shared account dstream cache", () => {
  beforeEach(() => {
    jest.resetModules();
    dstreamMock.mockReset();
    webappClient.removeAllListeners();
  });

  it("reuses the same account/name stream instance", async () => {
    const stream = new FakeDStream();
    dstreamMock.mockResolvedValue(stream);

    const { getSharedAccountDStream, resetSharedAccountDStreamCacheForTests } =
      await import("./account-dstream");
    try {
      const first = await getSharedAccountDStream({
        account_id: "account-1",
        name: "feed",
        ephemeral: true,
      });
      const second = await getSharedAccountDStream({
        account_id: "account-1",
        name: "feed",
        ephemeral: true,
      });

      expect(first).toBe(second);
      expect(dstreamMock).toHaveBeenCalledTimes(1);
    } finally {
      resetSharedAccountDStreamCacheForTests();
    }
  });

  it("drops stale account streams after sign-out", async () => {
    const first = new FakeDStream();
    const second = new FakeDStream();
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { getSharedAccountDStream, resetSharedAccountDStreamCacheForTests } =
      await import("./account-dstream");
    try {
      await getSharedAccountDStream({
        account_id: "account-1",
        name: "feed",
        ephemeral: true,
      });
      webappClient.emit("signed_out");
      await getSharedAccountDStream({
        account_id: "account-1",
        name: "feed",
        ephemeral: true,
      });

      expect(first.close).toHaveBeenCalled();
      expect(dstreamMock).toHaveBeenCalledTimes(2);
    } finally {
      resetSharedAccountDStreamCacheForTests();
    }
  });
});
