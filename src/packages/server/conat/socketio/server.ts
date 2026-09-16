/*
To start this standalone

   s = await require('@cocalc/server/conat/socketio').initConatServer()

When the hub runs with --conat-server, it now starts this on a dedicated port
and proxies /conat traffic to it.

How to make a cluster of two servers:

    s1 = await require('@cocalc/server/conat/socketio').initConatServer({port:3000, clusterName:'my-cluster', id:'s1', systemAccountPassword:'x', path:'/'}); 0

and in another session:

    s2 = await require('@cocalc/server/conat/socketio').initConatServer({port:3001,  clusterName:'my-cluster', id:'s2', systemAccountPassword:'x', path:'/'}); 0

    await s2.join('http://localhost:3000')

    s2.clusterTopology()

        // { 'my-cluster': { s1: 'http://localhost:3000', s2: 'http://localhost:3001' }}

Then in another terminal, make a client connected to each:

    c1 = require('@cocalc/conat/core/client').connect({address:'http://localhost:3000',
     systemAccountPassword:'x'});
    c2 = require('@cocalc/conat/core/client').connect({address:'http://localhost:3001',
     systemAccountPassword:'x'});

    c1.watch('foo')
    c2.publishSync('foo', 'hi')

*/

import { hostname } from "node:os";
import { join } from "node:path";

import basePath from "@cocalc/backend/base-path";
import "@cocalc/backend/conat";
import "@cocalc/backend/conat/persist"; // initializes context
import {
  conatClusterName as clusterName,
  conatClusterHealthPort,
  conatClusterPort,
  conatPassword,
  conatSocketioCount,
  setConatClusterPort,
} from "@cocalc/backend/data";
import { getLogger } from "@cocalc/backend/logger";
import { secureRandomString } from "@cocalc/backend/misc";
import port from "@cocalc/backend/port";
import type { ConatServer } from "@cocalc/conat/core/server";
import {
  init as createConatServer,
  type Options,
} from "@cocalc/conat/core/server";
import { getUser, isAllowed } from "./auth";
import { dnsScan, localAddress, SCAN_INTERVAL } from "./dns-scan";
import { handleHealth } from "./health";
import { handleMetrics, initMetrics } from "./metrics";
import { startHubConatManagedEgressLoop } from "./managed-egress";
import { configureHubServiceAdmissionDenialRecorder } from "../api/service-admission-denials";
import { startConatAdmissionSettingsRefresh } from "../admission-settings";
import {
  ensureLocalSeedBayCredential,
  isBayCredentialUserActive,
} from "@cocalc/server/inter-bay/bay-credentials";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";

const logger = getLogger("conat-server");
const BAY_CREDENTIAL_SWEEP_MS = 5_000;

function startBayCredentialRevocationSweep(server: ConatServer): void {
  if (getConfiguredClusterRole() !== "seed") return;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    const bayConnections = Object.entries(server.getStatsSnapshot()).filter(
      ([, stats]) => (stats.user as any)?.bay_credential_id,
    );
    if (!bayConnections.length) {
      running = false;
      return;
    }
    try {
      const checks = await Promise.all(
        bayConnections.map(async ([id, stats]) => ({
          id,
          active: await isBayCredentialUserActive(stats.user as any),
        })),
      );
      const revoked = checks
        .filter(({ active }) => !active)
        .map(({ id }) => id);
      if (revoked.length) {
        logger.info("disconnecting revoked bay credential connections", {
          count: revoked.length,
        });
        server.disconnectSockets(revoked);
      }
    } catch (err) {
      // Registry availability is part of bay authentication. If it cannot be
      // checked, disconnect every bay principal rather than extending access.
      const ids = bayConnections.map(([id]) => id);
      logger.error(
        "failed to check bay credential revocations; disconnecting bay connections",
        { count: ids.length, err },
      );
      server.disconnectSockets(ids);
    } finally {
      running = false;
    }
  }, BAY_CREDENTIAL_SWEEP_MS);
  timer.unref?.();
  server.once("closed", () => clearInterval(timer));
}

async function checkPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const { createServer } = require("http");
    const server = createServer();

    server.listen(port, () => {
      server.close(() => resolve());
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Another CoCalc server may already be running. Please stop the existing server or use a different port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

async function resolveStandalonePort(): Promise<number> {
  const explicitPort = process.env.CONAT_CLUSTER_PORT != null;
  try {
    await checkPortAvailable(conatClusterPort);
    return conatClusterPort;
  } catch (err) {
    if (
      explicitPort ||
      (conatSocketioCount ?? 1) > 1 ||
      !(err instanceof Error)
    ) {
      throw err;
    }
    logger.warn(
      `preferred Conat port ${conatClusterPort} is unavailable; falling back to a random localhost port`,
    );
    return 0;
  }
}

function publishStandalonePort(server: ConatServer): void {
  const actual = Number.parseInt(new URL(server.address()).port, 10);
  if (Number.isFinite(actual) && actual > 0) {
    setConatClusterPort(actual);
  }
}

function attachManagedEgressLoop({
  server,
  systemAccountPassword,
}: {
  server: ConatServer;
  systemAccountPassword?: string;
}): void {
  if (!systemAccountPassword) {
    return;
  }
  const systemClient = server.client({
    systemAccountPassword,
  });
  startHubConatManagedEgressLoop({
    conatServer: server,
    systemClient,
  });
}

export async function init(
  options0: Partial<Options> & { kucalc?: boolean } = {},
) {
  logger.debug("init");
  configureHubServiceAdmissionDenialRecorder();
  startConatAdmissionSettingsRefresh();
  if (getConfiguredClusterRole() === "seed") {
    await ensureLocalSeedBayCredential();
  }
  const { kucalc, ...options } = options0;
  const configuredClusterLinkPassword =
    `${process.env.COCALC_CONAT_SHARED_SECRET ?? ""}`.trim() || undefined;
  const clusterRole = getConfiguredClusterRole();

  if (kucalc) {
  }

  const opts = {
    getUser,
    isAllowed,
    systemAccountPassword:
      options.systemAccountPassword ?? (await secureRandomString(64)),
    clusterLinkPassword:
      options.clusterLinkPassword ??
      configuredClusterLinkPassword ??
      (await secureRandomString(64)),
    path: join(basePath, "conat"),
    port,
    clusterName,
    ...options,
  };

  if (kucalc) {
    // In Kubernetes we do two things differently:
    //   - the server id is derived from the hostname
    //   - we use dns to periodically lookup the other servers and join to them.
    // we might switch to something else, but for now this should be fine
    opts.systemAccountPassword = conatPassword;
    if (
      clusterRole !== "standalone" &&
      !options.clusterLinkPassword &&
      !configuredClusterLinkPassword
    ) {
      throw Error(
        "multibay clustered Conat requires COCALC_CONAT_SHARED_SECRET",
      );
    }
    // Existing single-bay Kubernetes deployments use the hub password for
    // their internal links. Multibay requires the dedicated per-bay secret.
    opts.clusterLinkPassword =
      options.clusterLinkPassword ??
      configuredClusterLinkPassword ??
      conatPassword;
    if (
      clusterRole !== "standalone" &&
      opts.clusterLinkPassword === opts.systemAccountPassword
    ) {
      throw Error(
        "multibay Conat cluster-link and generic system credentials must differ",
      );
    }
    opts.clusterIpAddress = await localAddress();
    if (!opts.clusterName) {
      opts.clusterName = "default";
    }
    if (!opts.id) {
      opts.id = hostname().split("-").slice(-1)[0];
    }
    // make this very short in k8s because we use the k8s api to get
    // the exact nodes frequently, so even if there was a temporary split
    // brain and each side stopped trying to connect to the other side,
    // things would get fixed by k8s within SCAN_INTERVAL.
    opts.forgetClusterNodeInterval = 4 * SCAN_INTERVAL;
    const server = createConatServer(opts);
    startBayCredentialRevocationSweep(server);
    attachManagedEgressLoop({
      server,
      systemAccountPassword: opts.systemAccountPassword,
    });
    // enable dns scanner
    dnsScan(server); // we don't await it, it runs forever
    await startVitalsServer(server);
    return server;
  }

  if (
    clusterRole !== "standalone" &&
    opts.clusterLinkPassword === opts.systemAccountPassword
  ) {
    throw Error(
      "multibay Conat cluster-link and generic system credentials must differ",
    );
  }

  if ((conatSocketioCount ?? 1) <= 1) {
    const standalonePort = await resolveStandalonePort();
    const server = createConatServer({
      ...opts,
      ssl: false,
      httpServer: undefined,
      port: standalonePort,
    });
    startBayCredentialRevocationSweep(server);
    attachManagedEgressLoop({
      server,
      systemAccountPassword: opts.systemAccountPassword,
    });
    publishStandalonePort(server);
    return server;
  } else {
    const server = createConatServer({
      ...opts,
      ssl: false,
      httpServer: undefined,
      port: conatClusterPort,
      localClusterSize: conatSocketioCount,
      clusterName: "default",
      id: "node",
    });
    startBayCredentialRevocationSweep(server);
    attachManagedEgressLoop({
      server,
      systemAccountPassword: opts.systemAccountPassword,
    });
    return server;
  }
}

async function startVitalsServer(server: ConatServer) {
  // create shared HTTP server for health and metrics endpoints
  const { createServer } = await import("http");
  const vitalsServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      handleHealth(server, req, res);
    } else if (req.method === "GET" && req.url === "/metrics") {
      handleMetrics(req, res);
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });
  vitalsServer.listen(conatClusterHealthPort);
  logger.debug(`starting vitals server on port ${conatClusterHealthPort}`);
  initMetrics(server); // start prometheus metrics collection
}
