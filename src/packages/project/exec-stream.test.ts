jest.mock("@cocalc/project/conat/runtime-client", () => ({
  getProjectConatClient: jest.fn(),
}));

jest.mock("@cocalc/project/conat/connection", () => ({
  connectToConat: jest.fn(),
}));

jest.mock("@cocalc/backend/exec-stream", () => ({
  executeStream: jest.fn(),
}));

import { getProjectConatClient } from "@cocalc/project/conat/runtime-client";
import { connectToConat } from "@cocalc/project/conat/connection";
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
});
