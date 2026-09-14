import { SDK } from "@nebius/js-sdk";
import { ExchangeableBearer } from "@nebius/js-sdk/runtime/token/exchangeable";
import { RenewableBearer } from "@nebius/js-sdk/runtime/token/renewable";
import { Token } from "@nebius/js-sdk/runtime/token";
import { NebiusClient } from "../nebius/client";

const creds = {
  parentId: "offline",
  serviceAccountId: "offline",
  publicKeyId: "offline",
  privateKeyPem: "offline",
};

afterEach(() => jest.restoreAllMocks());

it("closes the real SDK's service-account renewal timers", async () => {
  // Only token exchange is fake: no private key, cloud credentials or network.
  jest.spyOn(ExchangeableBearer.prototype, "receiver").mockImplementation(
    () =>
      ({
        fetch: async () =>
          new Token("synthetic", new Date(Date.now() + 3_600_000)),
      }) as any,
  );
  const close = jest.spyOn(SDK.prototype, "close");
  const renewalClose = jest.spyOn(RenewableBearer.prototype, "close");
  const fetch = jest.spyOn(RenewableBearer.prototype, "fetch");
  const client = new NebiusClient(creds);
  try {
    const sdk: SDK = (client as any).sdk;
    await sdk
      .getAuthorizationProvider()!
      .authenticator()
      .authenticate({ add() {} } as any);
    // Let the initial background renewal finish and schedule its next timer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const renewer = fetch.mock.contexts[0] as any;
    expect(renewer.refreshTimer).not.toBeNull();
    await client[Symbol.asyncDispose]();
    await client.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(renewalClose).toHaveBeenCalledTimes(1);
    expect(renewer.stopped).toBe(true);
    expect(renewer.refreshTimer).toBeNull();
  } finally {
    await client.close();
  }
});

it("does not replace an operation result or error when cleanup fails", async () => {
  jest
    .spyOn(SDK.prototype, "close")
    .mockRejectedValue(new Error("cleanup failed"));
  async function operation(fail: boolean) {
    await using client = new NebiusClient(creds);
    expect(client.parentId()).toBe("offline");
    if (fail) throw new Error("original failure");
    return "created";
  }
  await expect(operation(false)).resolves.toBe("created");
  await expect(operation(true)).rejects.toThrow("original failure");
});
