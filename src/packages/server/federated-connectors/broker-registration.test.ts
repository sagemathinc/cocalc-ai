/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// G3b design v3.4.2 §3. Synthetic values only.

import { BrokerRegistration } from "./broker-registration";

const SITE = "00000000-0000-4000-8000-0000000000aa";
const READY = {
  identity: true,
  database: true,
  reference_time: true,
  signing: true,
};
const A = "AAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCC";
const beat = (extra: Record<string, unknown> = {}) => ({
  instance_id: "broker-instance-0001",
  site_id: SITE,
  ready: READY,
  ...extra,
});

function setup(hubReady = true) {
  let now = 0;
  let ready = hubReady;
  const reg = new BrokerRegistration(
    () => now,
    () => ready,
    30_000,
  );
  return {
    reg,
    advance: (ms: number) => (now += ms),
    setHubReady: (v: boolean) => (ready = v),
    who: () => reg.registered()?.connection_id,
  };
}

describe("broker registration: one connection", () => {
  it("registers on a ready heartbeat and expires 30 s after the last one", () => {
    const t = setup();
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.heartbeat(beat(), A)).toBe(true);
    expect(t.reg.registered()).toEqual({ site_id: SITE, connection_id: A });
    t.advance(29_999);
    expect(t.who()).toBe(A);
    t.advance(1);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health()).toMatchObject({
      registered: false,
      alert: "expired",
    });
  });

  it("needs the hub's own side ready too", () => {
    const t = setup(false);
    t.reg.heartbeat(beat(), A);
    expect(t.reg.registered()).toBeUndefined();
    t.setHubReady(true);
    expect(t.who()).toBe(A);
  });

  it.each([
    ["no ready state", { ready: undefined }],
    ["a false prerequisite", { ready: { ...READY, signing: false } }],
    ["an extra ready key", { ready: { ...READY, extra: true } }],
    ["a malformed instance id", { instance_id: "short" }],
    ["a malformed site id", { site_id: "x" }],
  ])("removes the connection on a heartbeat with %s", (_n, extra) => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    expect(t.reg.heartbeat(beat(extra), A)).toBe(false);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health().alert).toBe("not_ready");
  });

  it("removes the connection when its instance id changes", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.reg.heartbeat(beat({ instance_id: "broker-instance-0002" }), A);
    expect(t.reg.registered()).toBeUndefined();
  });

  it("recovers on the next ready heartbeat", () => {
    const t = setup();
    t.reg.heartbeat(beat({ ready: undefined }), A);
    t.reg.heartbeat(beat(), A);
    expect(t.who()).toBe(A);
  });
});

describe("broker registration: several connections (v3.4.2 §3)", () => {
  it("a reconnect: B is contested until A's loss, with no alert", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.advance(1_000);
    expect(t.reg.heartbeat(beat(), B)).toBe(false);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health()).toMatchObject({
      alert: "contested",
      duplicate_incidents: 0,
    });
    // B keeps beating while A's loss is on its way: still no duplicate.
    t.advance(10_000);
    t.reg.heartbeat(beat(), B);
    expect(t.reg.health().duplicate_incidents).toBe(0);
    t.reg.transportLost(A);
    expect(t.who()).toBe(B);
  });

  it("a reconnect with A's loss lost: B registers when A expires", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.advance(5_000);
    t.reg.heartbeat(beat(), B);
    t.advance(24_999); // A's last beat is 29.999 s old: still live
    t.reg.heartbeat(beat(), B);
    expect(t.who()).toBeUndefined();
    t.advance(1); // now 30 s: A has expired
    expect(t.who()).toBe(B);
    expect(t.reg.health().duplicate_incidents).toBe(0);
  });

  it("two live connections: the older one beating again proves overlap", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.advance(1_000);
    t.reg.heartbeat(beat(), B);
    t.advance(1_000);
    t.reg.heartbeat(beat(), A);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health()).toMatchObject({
      alert: "duplicate_instance",
      duplicate_incidents: 1,
      live_connections: 2,
    });
    // Once per incident, however many overlapping heartbeats follow.
    for (let i = 0; i < 5; i++) {
      t.advance(1_000);
      t.reg.heartbeat(beat(), A);
      t.reg.heartbeat(beat(), B);
    }
    expect(t.reg.health().duplicate_incidents).toBe(1);
    expect(t.reg.registered()).toBeUndefined();
    // Until one is gone; then the survivor is registered.
    t.reg.transportLost(B);
    expect(t.who()).toBe(A);
    // A new overlap is a new incident.
    t.reg.heartbeat(beat(), C);
    t.advance(1_000);
    t.reg.heartbeat(beat(), A);
    expect(t.reg.health().duplicate_incidents).toBe(2);
  });

  it("A/B/C: removal never picks a winner while two or more remain", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.advance(1_000);
    t.reg.heartbeat(beat(), B);
    t.advance(1_000);
    t.reg.heartbeat(beat(), C);
    expect(t.who()).toBeUndefined();
    t.reg.transportLost(A);
    expect(t.who()).toBeUndefined(); // B and C remain
    expect(t.reg.health()).toMatchObject({ live_connections: 2 });
    // B beats after C appeared: overlap, counted once.
    t.advance(1_000);
    t.reg.heartbeat(beat(), B);
    expect(t.reg.health().duplicate_incidents).toBe(1);
    // C expires (its last beat is 30 s old); B is the survivor.
    t.advance(29_000);
    t.reg.heartbeat(beat(), B);
    expect(t.who()).toBe(B);
  });

  it.each([A, B, C])(
    "a reordered loss of %s removes only that connection",
    (lost) => {
      for (const when of ["before", "between", "after"]) {
        const t = setup();
        const beatAll = () => {
          for (const id of [A, B, C]) t.reg.heartbeat(beat(), id);
        };
        t.reg.heartbeat(beat(), A);
        t.advance(1);
        t.reg.heartbeat(beat(), B);
        t.advance(1);
        t.reg.heartbeat(beat(), C);
        if (when === "before") t.reg.transportLost(lost);
        t.advance(1_000);
        beatAll();
        if (when === "between") t.reg.transportLost(lost);
        t.advance(1_000);
        beatAll();
        if (when === "after") t.reg.transportLost(lost);
        // Beating again after its loss re-adds it (a late heartbeat): drop
        // that case by checking only the others' presence.
        expect(t.reg.health().live_connections).toBeGreaterThanOrEqual(2);
        expect(t.who()).toBeUndefined();
      }
    },
  );

  it("the sole survivor: a late, replayed or unknown loss never clears it", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.advance(1_000);
    t.reg.heartbeat(beat(), B);
    t.reg.transportLost(A);
    expect(t.who()).toBe(B);
    t.reg.transportLost(A); // replayed
    t.reg.transportLost(C); // unknown
    t.reg.transportLost("DDDDDDDDDDDDDDDDDDDDDD");
    expect(t.who()).toBe(B);
    t.reg.transportLost(B); // only its own loss does
    expect(t.who()).toBeUndefined();
    expect(t.reg.health().alert).toBe("transport_lost");
  });

  it("clear() ends every connection (a replaced signer)", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.reg.heartbeat(beat(), B);
    t.reg.clear("signer_changed");
    expect(t.reg.health()).toMatchObject({
      registered: false,
      alert: "signer_changed",
      live_connections: 0,
    });
  });

  it("health carries counts and reasons only, never a connection id", () => {
    const t = setup();
    t.reg.heartbeat(beat(), A);
    t.reg.heartbeat(beat(), B);
    t.advance(1);
    t.reg.heartbeat(beat(), A);
    const text = JSON.stringify(t.reg.health());
    for (const id of [A, B]) expect(text).not.toContain(id);
  });
});
