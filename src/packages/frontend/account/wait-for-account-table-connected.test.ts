import { EventEmitter } from "events";

import { waitForAccountTableConnectedForSignIn } from "./wait-for-account-table-connected";

class MockAccountTable extends EventEmitter {
  constructor(private state: string | undefined = "connecting") {
    super();
  }

  get_state(): string | undefined {
    return this.state;
  }

  setState(state: string): void {
    this.state = state;
  }
}

describe("waitForAccountTableConnectedForSignIn", () => {
  it("returns immediately when the account table is already connected", async () => {
    const table = new MockAccountTable("connected");

    await expect(
      waitForAccountTableConnectedForSignIn(table),
    ).resolves.toBeUndefined();
  });

  it("waits for the account table connected event", async () => {
    const table = new MockAccountTable();
    const promise = waitForAccountTableConnectedForSignIn(table);

    table.setState("connected");
    table.emit("connected");

    await expect(promise).resolves.toBeUndefined();
  });

  it("does not reject when a stale account table closes before connecting", async () => {
    const table = new MockAccountTable();
    const promise = waitForAccountTableConnectedForSignIn(table);

    table.setState("closed");
    table.emit("closed");

    await expect(promise).resolves.toBeUndefined();
  });
});
