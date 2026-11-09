/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import { BrokerRegistration } from "./broker-registration";
import {
  acceptBrokerHeartbeat,
  startFederatedBrokerTransport,
} from "./broker-transport";

const ID = "109876543210987654321";
const OTHER = "109876543210987654322";
const BEAT = {
  instance_id: "instance-aaaaaaaaaaaa",
  site_id: "00000000-0000-4000-8000-000000000001",
  ready: {
    identity: true,
    database: true,
    reference_time: true,
    signing: true,
  },
};

function registration() {
  let now = 0;
  const reg = new BrokerRegistration(
    () => now,
    () => true,
  );
  return { reg, advance: (ms: number) => (now += ms) };
}

describe("acceptBrokerHeartbeat", () => {
  it("registers the broker for the signer recorded now", () => {
    const { reg } = registration();
    expect(
      acceptBrokerHeartbeat({
        beat: BEAT,
        caller: { federated_broker_signer_id: ID },
        currentSignerId: ID,
        registration: reg,
      }),
    ).toBe(true);
    expect(reg.registered()).toBeDefined();
  });

  it.each([
    ["no caller", undefined],
    ["a bay", { cluster_id: "c", bay_id: "b", bay_credential_id: "k" }],
    ["an account", { account_id: "a", auth_session_hash: null }],
  ])("ignores %s, leaving a registration alone", (_n, caller) => {
    const { reg } = registration();
    reg.heartbeat(BEAT, ID);
    expect(
      acceptBrokerHeartbeat({
        beat: BEAT,
        caller,
        currentSignerId: ID,
        registration: reg,
      }),
    ).toBe(false);
    expect(reg.registered()).toBeDefined();
  });

  it.each([
    ["another signer", { federated_broker_signer_id: OTHER }, ID],
    ["a mixed stamp", { federated_broker_signer_id: ID, bay_id: "b" }, ID],
    ["a replaced signer record", { federated_broker_signer_id: ID }, OTHER],
    ["no signer record", { federated_broker_signer_id: ID }, undefined],
  ])("ends the registration at once for %s", (_n, caller, current) => {
    const { reg } = registration();
    reg.heartbeat(BEAT, ID);
    expect(
      acceptBrokerHeartbeat({
        beat: BEAT,
        caller,
        currentSignerId: current,
        registration: reg,
      }),
    ).toBe(false);
    expect(reg.registered()).toBeUndefined();
    expect(reg.health().alert).toBe("signer_changed");
  });
});

describe("startFederatedBrokerTransport", () => {
  function fakeClient() {
    const queue: any[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const sub = {
      close: () => {
        closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
    const client = {
      subscribe: jest.fn(async () => sub),
    };
    return {
      client: client as any,
      deliver(mesg: any) {
        queue.push(mesg);
        wake?.();
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("sets the mint client, registers on stamped heartbeats, and closes the gate when the subscription ends", async () => {
    const { client, deliver } = fakeClient();
    const { reg } = registration();
    const setMintClient = jest.fn();
    const stop = await startFederatedBrokerTransport({
      client,
      clusterId: "cluster-1",
      currentSignerId: async () => ID,
      registration: reg,
      setMintClient,
    });
    expect(client.subscribe).toHaveBeenCalledWith(
      "broker.cluster-1.heartbeat.v1",
    );
    expect(setMintClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ getToken: expect.any(Function) }),
    );
    // The message can't name the broker: only the stamp counts.
    deliver({ data: { ...BEAT, federated_broker_signer_id: ID } });
    await flush();
    expect(reg.registered()).toBeUndefined();
    deliver({ data: BEAT, caller: { federated_broker_signer_id: ID } });
    await flush();
    expect(reg.registered()).toBeDefined();
    stop();
    await flush();
    expect(reg.registered()).toBeUndefined();
    expect(reg.health().alert).toBe("transport_lost");
    expect(setMintClient).toHaveBeenLastCalledWith(undefined);
  });

  it("fails closed when the signer record can't be read", async () => {
    const { client, deliver } = fakeClient();
    const { reg } = registration();
    await startFederatedBrokerTransport({
      client,
      clusterId: "cluster-1",
      currentSignerId: async () => {
        throw Error("database down");
      },
      registration: reg,
      setMintClient: () => {},
    });
    deliver({ data: BEAT, caller: { federated_broker_signer_id: ID } });
    await flush();
    expect(reg.registered()).toBeUndefined();
  });
});
