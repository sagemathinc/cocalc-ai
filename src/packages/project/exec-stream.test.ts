jest.mock("@cocalc/project/conat/runtime-client", () => ({
  getProjectConatClient: jest.fn(),
}));

jest.mock("@cocalc/project/conat/connection", () => ({
  connectToConat: jest.fn(),
}));

jest.mock("@cocalc/backend/exec-stream", () => ({
  executeStream: jest.fn(),
}));

jest.mock("@cocalc/project/data", () => ({
  project_id: "project-1",
}));

import { getProjectConatClient } from "@cocalc/project/conat/runtime-client";
import { connectToConat } from "@cocalc/project/conat/connection";
import { executeStream } from "@cocalc/backend/exec-stream";
import { init } from "./exec-stream";

const mockGetProjectConatClient = jest.mocked(getProjectConatClient);
const mockConnectToConat = jest.mocked(connectToConat);

function makeEmptySubscription() {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
  } as any;
}

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeSubscription(messages: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const mesg of messages) {
        yield mesg;
      }
    },
  } as any;
}

describe("project exec-stream startup", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("uses the runtime Conat client when no explicit client is provided", async () => {
    const subscribe = jest.fn().mockResolvedValue(makeEmptySubscription());
    mockGetProjectConatClient.mockReturnValue({ subscribe } as any);

    init();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockGetProjectConatClient).toHaveBeenCalledTimes(1);
    expect(mockConnectToConat).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("prefers the explicit client when one is provided", async () => {
    const subscribe = jest.fn().mockResolvedValue(makeEmptySubscription());
    const client = { subscribe } as any;

    init({ client });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockGetProjectConatClient).not.toHaveBeenCalled();
    expect(mockConnectToConat).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects requests above the active exec-stream cap", async () => {
    const release = deferred<void>();
    jest.mocked(executeStream).mockImplementation(async () => {
      await release.promise;
    });
    const respond1 = jest.fn();
    const respond2 = jest.fn();
    const subscribe = jest.fn().mockResolvedValue(
      makeSubscription([
        {
          data: { project_id: "project-1" },
          respondSync: respond1,
        },
        {
          data: { project_id: "project-1" },
          respondSync: respond2,
        },
      ]),
    );
    const client = { subscribe } as any;

    init({ client, maxActiveExecStreams: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(executeStream).toHaveBeenCalledTimes(1);
    expect(respond2).toHaveBeenCalledWith({
      error: "project exec-stream service is busy",
    });
    expect(respond2).toHaveBeenCalledWith(null);

    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
