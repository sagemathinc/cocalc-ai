/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

class FakeSocket extends EventEmitter {
  state = "ready";
  writes: any[] = [];
  answers = true;
  write(msg: any) {
    this.writes.push(msg);
  }
  async request(request: any) {
    if (request?.type === "ping") {
      if (!this.answers) throw Error("timeout");
      return { data: "pong" };
    }
    return { data: null };
  }
  close() {
    this.state = "closed";
  }
}

const sockets: FakeSocket[] = [];
let resource: any = null;
const requestReconnect = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: async () => ({
        socket: {
          connect: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          },
        },
      }),
      registerReconnectResource: (options: any) => {
        resource = options;
        return { requestReconnect, close: jest.fn() };
      },
    },
  },
}));

import { SharedBrowserConnection } from "./connection";

const hellos = (socket: FakeSocket) =>
  socket.writes.filter((msg) => msg.type === "hello");

async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
}

beforeEach(() => {
  sockets.length = 0;
  resource = null;
  requestReconnect.mockClear();
});

test("back in the tab: a service that answers gets hello again; a silent one, a new socket", async () => {
  const connection = new SharedBrowserConnection("p1", "cocalc-browser", {
    view: "frame:a",
  });
  await until(() => sockets.length === 1);
  expect(hellos(sockets[0])).toEqual([{ type: "hello", view: "frame:a" }]);
  // Checked whenever the user comes back to the tab, as terminals are.
  expect(resource.probeOnForeground()).toBe(true);
  expect(resource.isConnected()).toBe(true);

  // The service answers: the same socket, and hello again (which restarts
  // this viewer's stream).
  await resource.reconnect();
  expect(sockets).toHaveLength(1);
  expect(hellos(sockets[0])).toHaveLength(2);

  // It looks ready but nothing answers: start over on a new socket.
  sockets[0].answers = false;
  await resource.reconnect();
  expect(sockets[0].state).toBe("closed");
  expect(sockets).toHaveLength(2);
  expect(hellos(sockets[1])).toEqual([{ type: "hello", view: "frame:a" }]);
  // Events of the old socket no longer count.
  sockets[0].emit("closed");
  expect(requestReconnect).not.toHaveBeenCalled();

  connection.close();
  expect(resource.canReconnect()).toBe(false);
});

test("a socket the service closed asks to reconnect", async () => {
  const connection = new SharedBrowserConnection("p1", "cocalc-browser", {});
  const statuses: string[] = [];
  connection.on("status", (status) => statuses.push(status));
  await until(() => sockets.length === 1);
  sockets[0].emit("closed");
  expect(requestReconnect).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "shared_browser_socket_closed" }),
  );
  expect(statuses).toContain("reconnecting");
  connection.close();
});
