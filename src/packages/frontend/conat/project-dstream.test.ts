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
});
