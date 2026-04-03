import callHub from "@cocalc/conat/hub/call-hub";
import hubBridge from "./hub-bridge";

jest.mock("@cocalc/conat/hub/call-hub", () => jest.fn());

const mockCallHub = jest.mocked(callHub);

describe("hubBridge explicit routing", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("passes the provided Conat client through to callHub", async () => {
    const client = { id: "client-1" } as any;
    mockCallHub.mockResolvedValue({ ok: true } as any);

    await expect(
      hubBridge({
        client,
        account_id: "acc-1",
        name: "system.ping",
        args: [],
        timeout: 5000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mockCallHub).toHaveBeenCalledWith({
      client,
      account_id: "acc-1",
      name: "system.ping",
      args: [],
      timeout: 5000,
    });
  });
});
