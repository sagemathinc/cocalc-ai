import { EventEmitter } from "events";
import * as liteSync from "./sync";
import { ConatClient } from "@cocalc/frontend/conat/client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "account-1",
  },
}));

jest.mock("@cocalc/frontend/conat/client", () => ({
  ConatClient: jest.fn(),
}));

class FakeDoc extends EventEmitter {
  public path = "test.chat";
  public fs = { lockFile: jest.fn() };
  public push = jest.fn();
  public pull = jest.fn();
  public close = jest.fn(async () => {
    this.state = "closed";
    this.emit("closed");
  });
  public doctype = { type: "string" };
  public client = { client_id: () => "local-client" };
  private state: "ready" | "closed" = "ready";

  get_state() {
    return this.state;
  }
}

describe("connectToRemote", () => {
  it("cleans up local and remote listeners when the local doc closes", async () => {
    const doc = new FakeDoc();
    const doc2 = new FakeDoc();
    (ConatClient as unknown as jest.Mock).mockImplementation(() => ({
      conat: () => ({
        waitUntilSignedIn: async () => {},
        info: { user: { project_id: "project-1" } },
        sync: {
          string: async () => doc2,
        },
      }),
    }));

    await liteSync.connectToRemote(doc as any);

    expect(doc.listenerCount("before-save-to-disk")).toBe(1);
    expect(doc.listenerCount("change")).toBe(1);
    expect(doc.listenerCount("closed")).toBe(1);
    expect(doc2.listenerCount("before-save-to-disk")).toBe(1);
    expect(doc2.listenerCount("change")).toBe(1);
    expect(doc2.listenerCount("closed")).toBe(1);

    doc.emit("closed");

    expect(doc2.close).toHaveBeenCalledTimes(1);
    expect(doc.listenerCount("before-save-to-disk")).toBe(0);
    expect(doc.listenerCount("change")).toBe(0);
    expect(doc.listenerCount("closed")).toBe(0);
    expect(doc2.listenerCount("before-save-to-disk")).toBe(0);
    expect(doc2.listenerCount("change")).toBe(0);
    expect(doc2.listenerCount("closed")).toBe(0);
  });
});
