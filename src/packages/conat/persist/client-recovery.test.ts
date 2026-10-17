/*
 *  This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { disablePermissionCheck, stream } from "@cocalc/conat/persist/client";

class FakeSocket extends EventEmitter {
  state = "ready";
  close = jest.fn();
  write = jest.fn();
}

function createClient({ registerRecoveryWithScheduler = true } = {}) {
  const socket = new FakeSocket();
  const requestRecovery = jest.fn();
  const registration = {
    requestRecovery,
    close: jest.fn(),
  };
  const registerResource = jest.fn(() => registration);
  const client: any = {
    id: `client-${Math.random()}`,
    state: "connected",
    socket: {
      connect: jest.fn(() => socket),
    },
    recoveryScheduler: {
      registerResource,
    },
  };
  const persist: any = stream({
    client,
    user: { hub_id: "test" },
    storage: { path: `test/${Math.random()}` },
    noCache: true,
    registerRecoveryWithScheduler,
  });
  persist.changefeeds.push({ close: jest.fn() });
  persist.reconnecting = true;
  return {
    persist,
    registration,
    registerResource,
    requestRecovery,
    socket,
  };
}

describe("persist socket-ready recovery", () => {
  beforeAll(() => {
    process.env.COCALC_TEST_MODE = "true";
    disablePermissionCheck();
  });

  it("routes catch-up through the recovery scheduler", () => {
    const { persist, requestRecovery, socket } = createClient();
    const getMissed = jest.fn();
    persist.getMissed = getMissed;

    socket.emit("ready");

    expect(getMissed).not.toHaveBeenCalled();
    expect(requestRecovery).toHaveBeenCalledWith({
      reason: "persist_socket_ready",
      resetBackoff: true,
    });
    expect(persist.getRecoveryState()).toBe("recovering");
    persist.close();
  });

  it("contains catch-up failures when recovery scheduling is disabled", async () => {
    const { persist, registerResource, socket } = createClient({
      registerRecoveryWithScheduler: false,
    });
    persist.getMissed = jest.fn(async () => {
      throw new Error("catch-up failed");
    });

    socket.emit("ready");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registerResource).not.toHaveBeenCalled();
    expect(persist.getRecoveryState()).toBe("disconnected");
    persist.close();
  });
});

describe("persist stream open errors", () => {
  beforeAll(() => {
    process.env.COCALC_TEST_MODE = "true";
    disablePermissionCheck();
  });

  it("reconnects after a storage error instead of closing the shared client", () => {
    const { persist, socket } = createClient();
    persist.on("error", () => {});

    socket.emit("data", null, {
      error: "Error: disk I/O error",
      code: "SQLITE_IOERR",
    });

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(persist.isClosed()).toBe(false);
    persist.close();
  });

  it("shuts down a cached client denied permission without stealing references", () => {
    const sockets: FakeSocket[] = [];
    const client: any = {
      id: `client-${Math.random()}`,
      state: "connected",
      socket: {
        connect: jest.fn(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }),
      },
      recoveryScheduler: {
        registerResource: jest.fn(() => ({
          requestRecovery: jest.fn(),
          close: jest.fn(),
        })),
      },
    };
    const options = {
      client,
      user: { hub_id: "test" },
      storage: { path: `test/${Math.random()}` },
    };
    // Two holders share one cached client.
    const first: any = stream(options);
    const second: any = stream(options);
    expect(second).toBe(first);
    first.on("error", () => {});

    sockets[0].emit("data", null, { error: "permission denied", code: 403 });

    expect(first.isClosed()).toBe(true);
    // The denied client is no longer handed out...
    const third: any = stream(options);
    expect(third).not.toBe(first);
    expect(third.isClosed()).toBe(false);
    // ...and releasing the old holders does not touch the replacement.
    first.close();
    second.close();
    expect(third.isClosed()).toBe(false);
    expect(Object.values(stream.info().count)).toEqual([1]);
    third.close();
    expect(third.isClosed()).toBe(true);
  });
});

describe("persist recovery of a stream that cannot be replayed", () => {
  beforeAll(() => {
    process.env.COCALC_TEST_MODE = "true";
    disablePermissionCheck();
  });

  it("stops after a 413 instead of repeating the replay", async () => {
    const { persist, socket } = createClient();
    (socket as any).waitUntilReady = jest.fn(async () => {});
    const tooLarge = Object.assign(new Error("message too large"), {
      code: 413,
    });
    persist.getAll = jest.fn(async () => {
      throw tooLarge;
    });
    const errors: any[] = [];
    persist.on("error", (err) => errors.push(err));

    await persist.getMissed0({ priority: "foreground" });

    expect(persist.getAll).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([tooLarge]);
    persist.close();
  });
});

describe("persist server instance changes", () => {
  beforeAll(() => {
    process.env.COCALC_TEST_MODE = "true";
    disablePermissionCheck();
  });

  function changesAfter(sequence: unknown[]) {
    const { persist } = createClient();
    const changed: unknown[] = [];
    persist.on("instance-changed", (instance) => changed.push(instance));
    const lastSeqs: unknown[] = [];
    for (const instance of sequence) {
      persist.lastSeq = 7;
      persist.noteInstance(instance);
      lastSeqs.push(persist.lastSeq);
    }
    persist.close();
    return { changed, lastSeqs };
  }

  it("does nothing on the first read or while the instance stays the same", () => {
    expect(changesAfter(["a", "a"])).toEqual({ changed: [], lastSeqs: [7, 7] });
    // a disk stream, or an old server: never an instance
    expect(changesAfter([undefined, undefined]).changed).toEqual([]);
  });

  it("starts over when the instance changes", () => {
    expect(changesAfter(["a", "b"])).toEqual({
      changed: ["b"],
      lastSeqs: [7, 0],
    });
  });

  it("starts over when a server without instances is replaced by one with them, or back", () => {
    // a rolling upgrade restarts the server, which loses the ephemeral stream
    expect(changesAfter([undefined, "a"]).changed).toEqual(["a"]);
    expect(changesAfter(["a", undefined]).changed).toEqual([null]);
  });
});
