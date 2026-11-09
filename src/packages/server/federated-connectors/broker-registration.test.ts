/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { BrokerRegistration } from "./broker-registration";

const SITE = "00000000-0000-4000-8000-0000000000aa";
const READY = {
  identity: true,
  database: true,
  reference_time: true,
  signing: true,
};
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
  };
}

describe("broker registration", () => {
  it("registers on a ready heartbeat and expires 30 s after the last one", () => {
    const t = setup();
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.heartbeat(beat(), "conn-1")).toBe(true);
    expect(t.reg.registered()).toEqual({
      site_id: SITE,
      connection_id: "conn-1",
    });
    t.advance(29_000);
    t.reg.heartbeat(beat(), "conn-1");
    t.advance(29_000);
    expect(t.reg.registered()).toBeDefined();
    t.advance(1_000);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health()).toEqual({ registered: false, alert: "expired" });
  });

  it.each([
    ["identity not verified", { ready: { ...READY, identity: false } }],
    ["database not ready", { ready: { ...READY, database: false } }],
    ["no fresh reference time", { ready: { ...READY, reference_time: false } }],
    ["not able to sign", { ready: { ...READY, signing: false } }],
    [
      "a missing ready field",
      { ready: { identity: true, database: true, reference_time: true } },
    ],
    ["an extra ready field", { ready: { ...READY, other: true } }],
    ["a truthy non-boolean", { ready: { ...READY, identity: 1 } }],
    ["a bad site id", { site_id: "site" }],
    ["a bad instance id", { instance_id: "x" }],
  ])("clears the registration at once on %s", (_name, extra) => {
    const t = setup();
    t.reg.heartbeat(beat(), "conn-1");
    expect(t.reg.heartbeat(beat(extra), "conn-1")).toBe(false);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health().alert).toBe("not_ready");
  });

  it("a second instance or connection clears it: neither is trusted", () => {
    const t = setup();
    t.reg.heartbeat(beat(), "conn-1");
    expect(
      t.reg.heartbeat(beat({ instance_id: "broker-instance-0002" }), "conn-2"),
    ).toBe(false);
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health().alert).toBe("duplicate_instance");
    t.reg.heartbeat(beat(), "conn-1");
    expect(t.reg.heartbeat(beat(), "conn-2")).toBe(false);
    expect(t.reg.registered()).toBeUndefined();
  });

  it("losing the broker's connection clears it; another connection's loss doesn't", () => {
    const t = setup();
    t.reg.heartbeat(beat(), "conn-1");
    t.reg.transportLost("conn-9");
    expect(t.reg.registered()).toBeDefined();
    t.reg.transportLost("conn-1");
    expect(t.reg.registered()).toBeUndefined();
    expect(t.reg.health().alert).toBe("transport_lost");
  });

  it("recovers on the next ready heartbeat", () => {
    const t = setup();
    t.reg.heartbeat(beat({ ready: { ...READY, identity: false } }), "conn-1");
    expect(t.reg.registered()).toBeUndefined();
    t.reg.heartbeat(beat(), "conn-1");
    expect(t.reg.registered()).toBeDefined();
    expect(t.reg.health()).toEqual({ registered: true });
  });

  it("isn't registered while the hub's own side isn't ready", () => {
    const t = setup(false);
    t.reg.heartbeat(beat(), "conn-1");
    expect(t.reg.registered()).toBeUndefined();
    t.setHubReady(true);
    expect(t.reg.registered()).toBeDefined();
  });
});
