import { EventEmitter } from "events";

const dkvMock = jest.fn();
const webappClient = Object.assign(new EventEmitter(), {
  conat_client: {
    dkv: dkvMock,
  },
  removeListener: EventEmitter.prototype.removeListener,
});

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

class FakeDkv extends EventEmitter {
  close = jest.fn(() => {
    this.emit("closed");
  });
}

describe("shared account dkv cache", () => {
  beforeEach(() => {
    jest.resetModules();
    dkvMock.mockReset();
    webappClient.removeAllListeners();
  });

  it("reuses the same account/name dkv instance", async () => {
    const dkv = new FakeDkv();
    dkvMock.mockResolvedValue(dkv);

    const { getSharedAccountDkv, resetSharedAccountDkvCacheForTests } =
      await import("./account-dkv");
    try {
      const first = await getSharedAccountDkv({
        account_id: "account-1",
        name: "bookmarks",
      });
      const second = await getSharedAccountDkv({
        account_id: "account-1",
        name: "bookmarks",
      });

      expect(first).toBe(second);
      expect(dkvMock).toHaveBeenCalledTimes(1);
    } finally {
      resetSharedAccountDkvCacheForTests();
    }
  });

  it("drops stale account caches after sign-in changes", async () => {
    const first = new FakeDkv();
    const second = new FakeDkv();
    dkvMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { getSharedAccountDkv, resetSharedAccountDkvCacheForTests } =
      await import("./account-dkv");
    try {
      await getSharedAccountDkv({
        account_id: "account-1",
        name: "bookmarks",
      });
      webappClient.emit("signed_in", { account_id: "account-2" });
      await getSharedAccountDkv({
        account_id: "account-2",
        name: "bookmarks",
      });

      expect(first.close).toHaveBeenCalled();
      expect(dkvMock).toHaveBeenCalledTimes(2);
    } finally {
      resetSharedAccountDkvCacheForTests();
    }
  });
});
