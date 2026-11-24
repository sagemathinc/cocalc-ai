/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import { BrokerRegistration } from "./broker-registration";
import {
  acceptBrokerHeartbeat,
  acceptBrokerTransportLoss,
  startFederatedBrokerTransport,
} from "./broker-transport";

const ID = "109876543210987654321";
const OTHER = "109876543210987654322";
const CONN_A = "AAAAAAAAAAAAAAAAAAAAAA";
const CONN_B = "BBBBBBBBBBBBBBBBBBBBBB";
const stamp = (connection = CONN_A, signer = ID) => ({
  federated_broker_signer_id: signer,
  federated_broker_connection_id: connection,
});
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
  it("registers the broker's connection for the signer recorded now", () => {
    const { reg } = registration();
    expect(
      acceptBrokerHeartbeat({
        beat: BEAT,
        caller: stamp(),
        currentSignerId: ID,
        registration: reg,
      }),
    ).toBe(true);
    expect(reg.registered()?.connection_id).toBe(CONN_A);
  });

  it.each([
    ["no caller", undefined],
    ["a bay", { cluster_id: "c", bay_id: "b", bay_credential_id: "k" }],
    ["an account", { account_id: "a", auth_session_hash: null }],
    ["a loss stamp", { federated_broker_transport_lost: CONN_A }],
  ])("ignores %s, leaving a registration alone", (_n, caller) => {
    const { reg } = registration();
    reg.heartbeat(BEAT, CONN_A);
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
    ["another signer", stamp(CONN_A, OTHER), ID],
    ["a mixed stamp", { ...stamp(), bay_id: "b" }, ID],
    ["the old one-key stamp", { federated_broker_signer_id: ID }, ID],
    ["a malformed connection id", stamp("short"), ID],
    ["a replaced signer record", stamp(), OTHER],
    ["no signer record", stamp(), undefined],
  ])("ends the registration at once for %s", (_n, caller, current) => {
    const { reg } = registration();
    reg.heartbeat(BEAT, CONN_A);
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

describe("acceptBrokerTransportLoss", () => {
  it("removes only the connection the exact server-derived stamp names", () => {
    const { reg } = registration();
    reg.heartbeat(BEAT, CONN_A);
    expect(
      acceptBrokerTransportLoss({
        caller: { federated_broker_transport_lost: CONN_B },
        registration: reg,
      }),
    ).toBe(true);
    expect(reg.registered()?.connection_id).toBe(CONN_A);
    expect(
      acceptBrokerTransportLoss({
        caller: { federated_broker_transport_lost: CONN_A },
        registration: reg,
      }),
    ).toBe(true);
    expect(reg.registered()).toBeUndefined();
    expect(reg.health().alert).toBe("transport_lost");
  });

  it.each([
    ["no caller", undefined],
    ["extra keys", { federated_broker_transport_lost: CONN_A, bay_id: "b" }],
    ["a bay stamp", { cluster_id: "c", bay_id: "b", bay_credential_id: "k" }],
    ["the broker's own stamp", stamp()],
    ["a malformed id", { federated_broker_transport_lost: "x" }],
    ["a numeric id", { federated_broker_transport_lost: 1 }],
  ])("ignores %s", (_n, caller) => {
    const { reg } = registration();
    reg.heartbeat(BEAT, CONN_A);
    expect(acceptBrokerTransportLoss({ caller, registration: reg })).toBe(
      false,
    );
    expect(reg.registered()?.connection_id).toBe(CONN_A);
  });
});

describe("startFederatedBrokerTransport", () => {
  function fakeClient() {
    const subs = new Map<
      string,
      { queue: any[]; wake?: () => void; closed: boolean; end?: Error }
    >();
    const client = {
      subscribe: jest.fn(async (subject: string) => {
        const state = { queue: [] as any[], closed: false } as any;
        subs.set(subject, state);
        return {
          close: () => {
            state.closed = true;
            state.wake?.();
          },
          async *[Symbol.asyncIterator]() {
            while (true) {
              if (state.queue.length > 0) {
                yield state.queue.shift();
                continue;
              }
              if (state.closed) return;
              await new Promise<void>((r) => (state.wake = r));
            }
          },
        };
      }),
    };
    return {
      client: client as any,
      deliver(subject: string, mesg: any) {
        const s = subs.get(subject)!;
        s.queue.push(mesg);
        s.wake?.();
      },
      end(subject: string) {
        const s = subs.get(subject)!;
        s.closed = true;
        s.wake?.();
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const HB = "broker.cluster-1.heartbeat.v1";
  const LOSS = "broker.cluster-1.transport-lost.v1";

  async function start(currentSignerId = async (): Promise<any> => ID) {
    const f = fakeClient();
    const { reg, advance } = registration();
    const setMintClient = jest.fn();
    const stop = await startFederatedBrokerTransport({
      client: f.client,
      clusterId: "cluster-1",
      currentSignerId,
      registration: reg,
      setMintClient,
    });
    return { ...f, reg, advance, setMintClient, stop };
  }

  it("listens to heartbeats and loss events, and sets the mint client", async () => {
    const t = await start();
    expect(
      t.client.subscribe.mock.calls.map((c: any[]) => c[0]).sort(),
    ).toEqual([HB, LOSS].sort());
    expect(t.setMintClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ getToken: expect.any(Function) }),
    );
  });

  it("registers only on stamped heartbeats, and a loss event ends that connection", async () => {
    const t = await start();
    // The message can't name the broker: only the stamp counts.
    t.deliver(HB, { data: { ...BEAT, ...stamp() } });
    await flush();
    expect(t.reg.registered()).toBeUndefined();
    t.deliver(HB, { data: BEAT, caller: stamp() });
    await flush();
    expect(t.reg.registered()?.connection_id).toBe(CONN_A);
    // A loss named in the message, not the stamp, does nothing.
    t.deliver(LOSS, { data: { federated_broker_transport_lost: CONN_A } });
    await flush();
    expect(t.reg.registered()).toBeDefined();
    t.deliver(LOSS, {
      data: null,
      caller: { federated_broker_transport_lost: CONN_A },
    });
    await flush();
    expect(t.reg.registered()).toBeUndefined();
  });

  it("a reconnect: B registers once A's loss arrives, before or after B's first heartbeat", async () => {
    for (const order of ["loss-first", "beat-first"]) {
      const t = await start();
      t.deliver(HB, { data: BEAT, caller: stamp(CONN_A) });
      await flush();
      const loss = () =>
        t.deliver(LOSS, {
          data: null,
          caller: { federated_broker_transport_lost: CONN_A },
        });
      const beatB = () =>
        t.deliver(HB, {
          data: { ...BEAT, instance_id: "instance-bbbbbbbbbbbb" },
          caller: stamp(CONN_B),
        });
      if (order === "loss-first") {
        loss();
        await flush();
        beatB();
      } else {
        beatB();
        await flush();
        expect(t.reg.registered()).toBeUndefined(); // contested
        loss();
      }
      await flush();
      expect(t.reg.registered()?.connection_id).toBe(CONN_B);
      expect(t.reg.health().duplicate_incidents).toBe(0);
    }
  });

  it("closes the gate when either subscription ends", async () => {
    for (const subject of [HB, LOSS]) {
      const t = await start();
      t.deliver(HB, { data: BEAT, caller: stamp() });
      await flush();
      expect(t.reg.registered()).toBeDefined();
      t.end(subject);
      await flush();
      expect(t.reg.registered()).toBeUndefined();
      expect(t.reg.health().alert).toBe("transport_lost");
      expect(t.setMintClient).toHaveBeenLastCalledWith(undefined);
    }
  });

  it("fails closed when the signer record can't be read", async () => {
    const t = await start(async () => {
      throw Error("database down");
    });
    t.deliver(HB, { data: BEAT, caller: stamp() });
    await flush();
    expect(t.reg.registered()).toBeUndefined();
  });
});
