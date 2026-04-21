import { EventEmitter } from "events";

const dstreamMock = jest.fn();
const directDstreamMock = jest.fn();
const connectMock = jest.fn();
const webappClient = Object.assign(new EventEmitter(), {
  account_id: "account-1",
  browser_id: "browser-1",
  conat_client: {
    dstream: dstreamMock,
  },
  removeListener: EventEmitter.prototype.removeListener,
});

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

jest.mock("@cocalc/conat/core/client", () => ({
  connect: (...args) => connectMock(...args),
}));

jest.mock("@cocalc/conat/sync/dstream", () => {
  const actual = jest.requireActual("@cocalc/conat/sync/dstream");
  return {
    ...actual,
    dstream: (...args) => directDstreamMock(...args),
  };
});

class FakeDStream extends EventEmitter {
  private closed = false;

  close = jest.fn(() => {
    this.closed = true;
    this.emit("closed");
  });

  isClosed = jest.fn(() => this.closed);
}

describe("shared project dstream cache", () => {
  beforeEach(() => {
    jest.resetModules();
    dstreamMock.mockReset();
    directDstreamMock.mockReset();
    connectMock.mockReset();
    webappClient.removeAllListeners();
  });

  it("reuses the same project stream while multiple leases are held", async () => {
    const stream = new FakeDStream();
    dstreamMock.mockResolvedValue(stream);

    const {
      acquireSharedProjectDStream,
      resetSharedProjectDStreamCacheForTests,
    } = await import("./project-dstream");
    try {
      const first = await acquireSharedProjectDStream({
        project_id: "project-1",
        name: "feed",
        ephemeral: true,
      });
      const second = await acquireSharedProjectDStream({
        project_id: "project-1",
        name: "feed",
        ephemeral: true,
      });

      expect(first.stream).toBe(second.stream);
      expect(dstreamMock).toHaveBeenCalledTimes(1);

      await first.release();
      expect(stream.close).not.toHaveBeenCalled();

      await second.release();
      expect(stream.close).toHaveBeenCalledTimes(1);
    } finally {
      resetSharedProjectDStreamCacheForTests();
    }
  });

  it("drops stale project streams after sign-out", async () => {
    const first = new FakeDStream();
    const second = new FakeDStream();
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const {
      acquireSharedProjectDStream,
      resetSharedProjectDStreamCacheForTests,
    } = await import("./project-dstream");
    try {
      const lease = await acquireSharedProjectDStream({
        project_id: "project-1",
        name: "feed",
        ephemeral: true,
      });
      webappClient.emit("signed_out");
      await lease.release();
      const next = await acquireSharedProjectDStream({
        project_id: "project-1",
        name: "feed",
        ephemeral: true,
      });

      expect(first.close).toHaveBeenCalled();
      expect(next.stream).toBe(second);
      expect(dstreamMock).toHaveBeenCalledTimes(2);

      await next.release();
    } finally {
      resetSharedProjectDStreamCacheForTests();
    }
  });

  it("uses a direct control-plane client when controlPlaneOrigin is provided", async () => {
    const stream = new FakeDStream();
    const client = {
      close: jest.fn(),
      on: jest.fn(),
    };
    connectMock.mockReturnValue(client);
    directDstreamMock.mockResolvedValue(stream);

    const {
      acquireSharedProjectDStream,
      resetSharedProjectDStreamCacheForTests,
    } = await import("./project-dstream");
    try {
      const lease = await acquireSharedProjectDStream({
        project_id: "project-1",
        name: "feed",
        controlPlaneOrigin: "https://bay-2-lite4b.cocalc.ai",
      });

      expect(connectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "https://bay-2-lite4b.cocalc.ai",
          withCredentials: true,
          reconnection: false,
          noCache: true,
          forceNew: true,
        }),
      );
      expect(directDstreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
          name: "feed",
          client,
        }),
      );
      expect(dstreamMock).not.toHaveBeenCalled();

      await lease.release();
    } finally {
      resetSharedProjectDStreamCacheForTests();
    }
  });
});
