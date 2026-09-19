/** @jest-environment jsdom */

const mockConnect = jest.fn();

jest.mock("@cocalc/conat/core/client", () => ({ connect: mockConnect }));

import { withProjectHostAccountClient } from "./project-host-account-client";

describe("withProjectHostAccountClient", () => {
  beforeEach(() => {
    mockConnect.mockReset();
  });

  it("uses a one-shot bearer-authenticated connection", async () => {
    const waitUntilSignedIn = jest.fn(async () => undefined);
    const close = jest.fn();
    const client = { waitUntilSignedIn, close };
    mockConnect.mockReturnValue(client);
    const action = jest.fn(async () => "ok");

    await expect(
      withProjectHostAccountClient({
        account_id: "00000000-0000-4000-8000-000000000001",
        address: "https://project-host.example",
        token: "account-token",
        action,
      }),
    ).resolves.toBe("ok");

    const options = mockConnect.mock.calls[0][0];
    const auth = jest.fn();
    options.auth(auth);
    expect(auth).toHaveBeenCalledWith({ bearer: "account-token" });
    expect(options).toMatchObject({
      address: "https://project-host.example",
      reconnection: false,
      noCache: true,
      forceNew: true,
    });
    expect(waitUntilSignedIn).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(action).toHaveBeenCalledWith(client);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when the request fails", async () => {
    const close = jest.fn();
    mockConnect.mockReturnValue({
      waitUntilSignedIn: jest.fn(async () => undefined),
      close,
    });

    await expect(
      withProjectHostAccountClient({
        account_id: "00000000-0000-4000-8000-000000000001",
        address: "https://project-host.example",
        token: "account-token",
        action: async () => {
          throw Error("request failed");
        },
      }),
    ).rejects.toThrow("request failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
