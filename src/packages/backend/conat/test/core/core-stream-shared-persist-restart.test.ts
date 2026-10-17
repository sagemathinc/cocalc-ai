/*
A browser tab shares one persist client per stream path and connection
(persist/client.ts stream() cache).  After a router + persist restart, a stream
that opens while that shared client is already disconnected never sees the
"disconnected" event.  If the stream that saw it closes before its recovery
runs, nobody recovers the shared client, and the new stream retried its
bootstrap read forever ("getAllFromPersist - failed -- Error: disconnected")
until the tab was reloaded.

pnpm test ./core-stream-shared-persist-restart.test.ts
*/

import {
  before,
  after,
  connect,
  delay,
  initConatServer,
  path,
  persistServer as initialPersistServer,
  restartServer,
  wait,
} from "@cocalc/backend/conat/test/setup";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { CoreStream, cstream } from "@cocalc/conat/sync/core-stream";
import { once } from "@cocalc/util/async-utils";

beforeAll(before);

// Restarts the router and the persist server behind `client` together.  The
// router goes first, as on a host restart, so the persist server's close
// notice never reaches the client and its socket stays "disconnected" rather
// than "closed".  Returns a function that starts the new persist server.
type RestartHost = (persistClient) => Promise<() => Promise<{ close }>>;

function openWhileDisconnected({
  getClient,
  restartHost,
}: {
  getClient: () => any;
  restartHost: RestartHost;
}) {
  let client;
  let first;
  let second;
  let secondInit: Promise<void>;
  let initListening = false;
  const changes: any[] = [];
  let readyBeforeInit = false;
  let startPersist: () => Promise<{ close }>;
  let persistServer;
  const name = `shared-restart-${Math.random()}`;

  it("opens a stream and writes to it", async () => {
    client = getClient();
    first = await cstream({ client, name, noCache: true });
    await first.publish("before-restart");
    expect(first.persistClient.getRecoveryState()).toBe("ready");
  }, 30_000);

  it("restarts the router and the persist server together", async () => {
    startPersist = await restartHost(first.persistClient);
  }, 30_000);

  it("opens a second stream on the shared, already disconnected, persist client", async () => {
    expect(first.persistClient.getRecoveryState()).toBe("disconnected");
    second = new CoreStream({
      client,
      name,
      initPhaseReporter: (phase) => {
        if (phase == "listen_started") {
          initListening = true;
        }
      },
    });
    // init reads the existing history without emitting it, and only init
    // reports ready.
    second.on("change", ({ mesg }) => changes.push(mesg));
    second.on("recovery-state", (state) => {
      if (state == "ready" && !initListening) {
        readyBeforeInit = true;
      }
    });
    secondInit = second.init();
    secondInit.catch(() => {});
    expect(second.persistClient).toBe(first.persistClient);
    // The stream that saw the disconnect goes away before its recovery runs,
    // e.g. an editor that remounts after the reconnect.
    first.close();
  });

  it("starts a new persist server and the second stream finishes opening", async () => {
    // Longer than the recovery scheduler's first delay, so a recovery
    // started during init would run before init finishes.
    await delay(1300);
    persistServer = await startPersist();
    let timer;
    await Promise.race([
      secondInit,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("second stream never finished opening")),
          20_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    expect(readyBeforeInit).toBe(false);
    expect(changes).toEqual([]);
    expect(second.getAll()).toEqual(["before-restart"]);
    await second.publish("after-restart", { timeout: 5000 });
    await wait({ until: () => second.getAll().includes("after-restart") });
    expect(changes).toEqual(["after-restart"]);
  }, 30_000);

  it("cleans up", async () => {
    second?.close();
    await persistServer?.close();
  });
}

describe("a stream opened while its shared persist client is disconnected", () => {
  openWhileDisconnected({
    getClient: () => connect(),
    restartHost: async (persistClient) => {
      const disconnected = once(persistClient, "disconnected", 15_000);
      await restartServer();
      await disconnected;
      await initialPersistServer.close();
      return async () => createPersistServer({ client: connect() });
    },
  });
});

// The browser opens project streams on its main (hub) client, which routes
// their subjects to a per-host client connected to the project host's router,
// where the persist server runs.  Only the host restarts.
describe("the same through a routed per-host client", () => {
  let hostRouter;
  let hostClient;
  let hostPersistClient;
  let hostPersist;
  const hostClients: any[] = [];
  const connectToHost = () => {
    const cn = hostRouter.client({ noCache: true, path: "/" });
    hostClients.push(cn);
    return cn;
  };
  const startHostRouter = async (port?: number) => {
    hostRouter = await initConatServer({
      port,
      path,
      clusterName: "project-host",
      id: "project-host-router",
      systemAccountPassword: "secret",
    });
  };

  beforeAll(async () => {
    await startHostRouter();
    hostClient = connectToHost();
    hostPersistClient = connectToHost();
    hostPersist = createPersistServer({ client: hostPersistClient });
  });

  const getClient = () =>
    connect().setRouteSubject((subject) =>
      subject.startsWith("persist") ? { client: hostClient } : undefined,
    );
  const restartHost: RestartHost = async (persistClient) => {
    // The hub connection stays up, so only the per-host client can tell the
    // stream that its persist server went away.
    const disconnected = once(persistClient, "disconnected", 15_000);
    const port = hostRouter.options.port;
    await hostRouter.close();
    await disconnected;
    await hostPersist.close();
    hostPersistClient.close();
    await startHostRouter(port);
    return async () => {
      hostPersistClient = connectToHost();
      hostPersist = createPersistServer({ client: hostPersistClient });
      return hostPersist;
    };
  };

  describe("an open stream", () => {
    let stream;

    it("recovers after the host restarts", async () => {
      stream = await cstream({
        client: getClient(),
        name: `routed-open-${Math.random()}`,
        noCache: true,
      });
      await stream.publish("before-restart");
      const startPersist = await restartHost(stream.persistClient);
      await startPersist();
      await wait({
        timeout: 20_000,
        until: async () => {
          try {
            await stream.publish("after-restart", { timeout: 1000 });
            return true;
          } catch {
            return false;
          }
        },
      });
      await wait({ until: () => stream.getAll().includes("after-restart") });
    }, 40_000);

    it("cleans up", () => {
      stream?.close();
    });
  });

  describe("a stream opened while the shared client is disconnected", () => {
    openWhileDisconnected({ getClient, restartHost });
  });

  // When a project host moves to a new address the browser replaces its
  // per-host client and reconnects; sockets must then watch the new client.
  describe("a socket whose route moves to a new per-host client", () => {
    const subject = `routed-echo-${Math.random()}`;
    let route;
    let hub;
    let server;
    let sock;

    it("connects a socket routed through the first per-host client", async () => {
      route = connectToHost();
      const serverClient = connectToHost();
      server = serverClient.socket.listen(subject);
      server.on("connection", (conn) => {
        conn.on("request", (mesg) => mesg.respond("pong"));
      });
      hub = connect().setRouteSubject((s) =>
        s.startsWith(subject) ? { client: route } : undefined,
      );
      // As persist sockets do, find the server with a (routed) request rather
      // than the hub client's interest table.
      sock = hub.socket.connect(subject, {
        loadBalancer: async () => serverClient.id,
      });
      await sock.waitUntilReady(10_000);
      expect((await sock.request(null)).data).toBe("pong");
    }, 30_000);

    it("moves the route to a new client and reconnects through it", async () => {
      const old = route;
      route = connectToHost();
      old.close();
      await restartServer();
      await wait({
        timeout: 20_000,
        until: async () => {
          try {
            return (await sock.request(null, { timeout: 1000 })).data == "pong";
          } catch {
            return false;
          }
        },
      });
    }, 30_000);

    it("notices when the new client's host goes away", async () => {
      const disconnected = once(sock, "disconnected", 15_000);
      await hostRouter.close();
      await disconnected;
    }, 30_000);

    it("cleans up", async () => {
      sock?.close();
      server?.close();
      await startHostRouter(hostRouter.options.port);
    });
  });

  afterAll(async () => {
    for (const cn of hostClients) {
      cn.close();
    }
    await hostRouter?.close();
  });
});

afterAll(after);
