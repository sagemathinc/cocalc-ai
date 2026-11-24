/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The production adapters end to end (G3b design v3.4.2 §§1-3): a real conat
// server, real broker sockets with server-minted connection ids, the real
// bay transport and registration, and real disconnects.

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    silly: () => {},
  }),
}));

import { delay } from "awaiting";
import { Client, connect } from "@cocalc/conat/core/client";
import { ConatServer, init } from "@cocalc/conat/core/server";
import { publishFederatedBrokerHeartbeat } from "@cocalc/conat/inter-bay/federated-broker";
import { BrokerRegistration } from "./broker-registration";
import { startFederatedBrokerTransport } from "./broker-transport";

const ID = "109876543210987654321";
const CLUSTER = "cluster-1";
const BEAT = (instance: string) => ({
  instance_id: instance,
  site_id: "00000000-0000-4000-8000-000000000001",
  ready: {
    identity: true,
    database: true,
    reference_time: true,
    signing: true,
  },
});

async function until(f: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timed out");
    await delay(20);
  }
}

describe("the broker transport, end to end", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  async function setup() {
    const server = init({
      port: 0,
      getUser: async (socket) =>
        socket.handshake.auth.broker
          ? { hub_id: "federated-broker", federated_broker_signer_id: ID }
          : { hub_id: "bay-hub" },
      isAllowed: async () => true,
      federatedBrokerLossSubject: `broker.${CLUSTER}.transport-lost.v1`,
    });
    const bay = connect({ address: server.address(), noCache: true });
    await bay.waitUntilSignedIn({ timeout: 5_000 });
    const reg = new BrokerRegistration(
      () => performance.now(),
      () => true,
    );
    const stop = await startFederatedBrokerTransport({
      client: bay,
      clusterId: CLUSTER,
      currentSignerId: async () => ID,
      registration: reg,
      setMintClient: () => {},
    });
    const broker = async () => {
      const c = connect({
        address: server.address(),
        noCache: true,
        auth: { broker: true },
        reconnection: false,
      });
      await c.waitUntilSignedIn({ timeout: 5_000 });
      return c;
    };
    const beat = (c: Client, instance: string) =>
      publishFederatedBrokerHeartbeat(c, CLUSTER, BEAT(instance));
    return { reg, stop, broker, beat };
  }

  it("two real connections contest; the loss of one registers the other", async () => {
    const t = await setup();
    const a = await t.broker();
    await t.beat(a, "instance-aaaaaaaaaaaa");
    await until(() => t.reg.registered() != null);
    const first = t.reg.registered()!.connection_id;
    // A second socket of the same signer is a different connection.
    const b = await t.broker();
    await t.beat(b, "instance-bbbbbbbbbbbb");
    await until(() => t.reg.health().live_connections === 2);
    expect(t.reg.registered()).toBeUndefined();
    // Both alive and beating: overlap, once.
    await t.beat(a, "instance-aaaaaaaaaaaa");
    await until(() => t.reg.health().duplicate_incidents === 1);
    // A's socket closes: the server publishes its loss; B is the survivor.
    a.close();
    await until(() => t.reg.registered() != null);
    const second = t.reg.registered()!.connection_id;
    expect(second).not.toBe(first);
    // B closes too: nothing is registered.
    b.close();
    await until(() => t.reg.health().live_connections === 0);
    expect(t.reg.health().alert).toBe("transport_lost");
    t.stop();
  });

  it("a reconnect: the old socket's loss never clears the new one", async () => {
    const t = await setup();
    const a = await t.broker();
    await t.beat(a, "instance-aaaaaaaaaaaa");
    await until(() => t.reg.registered() != null);
    a.close();
    const b = await t.broker();
    await t.beat(b, "instance-aaaaaaaaaaaa");
    await until(
      () => t.reg.registered() != null && t.reg.health().live_connections === 1,
    );
    await delay(300); // any late loss for A has arrived by now
    expect(t.reg.registered()).toBeDefined();
    expect(t.reg.health().duplicate_incidents).toBe(0);
    t.stop();
  });
});
