import { Map as ImmutableMap } from "immutable";
import { EventEmitter } from "events";

jest.mock("./store", () => ({
  store: { get: jest.fn(), getIn: jest.fn(), get_state: jest.fn() },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    conat_client: { hub: { hosts: { resolveHostConnection: jest.fn() } } },
    async_query: jest.fn(),
  },
}));
jest.mock("socket.io-client", () => ({
  connect: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    close: jest.fn(),
    io: { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
  })),
}));

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { Client } from "@cocalc/conat/core/client";
import callHub from "@cocalc/conat/hub/call-hub";

it("expired normal host-info retries never publish after reconnect", async () => {
  jest.useFakeTimers();
  (store.get as jest.Mock).mockImplementation((key) =>
    key === "host_info" ? ImmutableMap() : undefined,
  );
  const actions = new ProjectsActions("projects", {
    getStore: jest.fn(() => ({})),
    _set_state: jest.fn(),
    removeActions: jest.fn(),
    getProjectActions: jest.fn(),
  } as any);
  const client: any = new Client({
    address: "http://example.invalid",
    autoConnect: false,
    noCache: true,
  });
  const inbox = new EventEmitter();
  inbox.setMaxListeners(0);
  client.inbox = inbox;
  client.inboxSubject = "INBOX.offline-probe";
  const published: unknown[] = [];
  client._publish = jest.fn((_subject, data, options) => {
    published.push(data);
    inbox.emit(Object.values(options.headers)[0] as string, {
      data: { host_id: "host-1" },
    });
    return { bytes: 1, getCount: () => 1, promise: Promise.resolve() };
  });
  const resolver = webapp_client.conat_client.hub.hosts
    .resolveHostConnection as jest.Mock;
  const requests = jest.spyOn(client, "request");
  resolver.mockImplementation((opts) =>
    callHub({
      client,
      account_id: "acct-1",
      name: "hosts.resolveHostConnection",
      args: [opts],
      timeout: 15_000,
    }),
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (let i = 0; i < 300; i++) {
      const first = actions.ensure_host_info("host-1");
      const second = actions.ensure_host_info("host-1");
      await jest.advanceTimersByTimeAsync(10_001);
      expect(await first).toBeUndefined();
      expect(await second).toBeUndefined();
    }
    expect(resolver).toHaveBeenCalledTimes(300);
    // Alternate retries join the still-pending 15-second underlying request.
    expect(requests).toHaveBeenCalledTimes(150);
    expect(published).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(20_000);
    client.state = "connected";
    client.info = { user: { account_id: "acct-1" } };
    client.emit("info");
    await jest.advanceTimersByTimeAsync(1);
    expect(published).toHaveLength(0);
    const fresh = actions.ensure_host_info("host-1", true);
    await jest.advanceTimersByTimeAsync(1);
    await expect(fresh).resolves.toBeDefined();
    expect(published).toHaveLength(1);
  } finally {
    client.close();
    warn.mockRestore();
    jest.useRealTimers();
  }
});
