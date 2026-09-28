import { EventEmitter } from "events";
import { getPersistServerInfo, getPersistServerId } from "./load-balancer";
import type { Client } from "../core/client";

describe("persist discovery compatibility", () => {
  it("accepts legacy IDs without claiming inbox-return support and shares the cache", async () => {
    const client = Object.assign(new EventEmitter(), {
      request: jest.fn().mockResolvedValue({ data: "legacy-server" }),
    });
    const opts = {
      client: client as unknown as Client,
      subject: "persist.project-test",
    };
    expect(await getPersistServerInfo(opts)).toEqual({ id: "legacy-server" });
    expect(await getPersistServerId(opts)).toBe("legacy-server");
    expect(client.request).toHaveBeenCalledTimes(1);
    client.emit("disconnected");
    client.request.mockResolvedValue({
      data: { id: "new-server", inboxReturn: 1 },
    });
    expect(await getPersistServerInfo(opts)).toEqual({
      id: "new-server",
      inboxReturn: 1,
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("does not cache malformed discovery responses", async () => {
    const client = Object.assign(new EventEmitter(), {
      request: jest
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: "valid" }),
    });
    const opts = {
      client: client as unknown as Client,
      subject: "persist.project-test",
    };
    await expect(getPersistServerInfo(opts)).rejects.toThrow(
      "invalid persist server",
    );
    expect(await getPersistServerInfo(opts)).toEqual({ id: "valid" });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});
