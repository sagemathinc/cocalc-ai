/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let stored: any;
let saveCalls = 0;
let saveFails = false;
let localHostId: string | undefined = "host-1";

jest.mock("./sqlite/hosts", () => ({
  __esModule: true,
  getLocalHostId: () => localHostId,
}));

jest.mock("./sqlite/pressure-policy", () => {
  const actual = jest.requireActual("./sqlite/pressure-policy");
  return {
    __esModule: true,
    isStoredPressurePolicy: actual.isStoredPressurePolicy,
    loadStoredPressurePolicy: () =>
      actual.isStoredPressurePolicy(stored) ? { ...stored } : undefined,
    saveStoredPressurePolicy: (policy: any) => {
      saveCalls += 1;
      if (saveFails) throw new Error("disk full");
      stored = { ...policy };
    },
  };
});

jest.mock("./master-conat-client", () => ({
  __esModule: true,
  getMasterConatClient: () => undefined,
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import {
  _test,
  getEffectivePressurePolicy,
  parsePressurePolicyReply,
  PRESSURE_POLICY_STALE_MS,
  refreshPressurePolicy,
} from "./pressure-policy";

const now = Date.parse("2026-11-24T06:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const reply = (over: Record<string, unknown> = {}) => ({
  host_id: "host-1",
  watch_only: true,
  reason: "private_host",
  evaluated_at: iso(now),
  ...over,
});
const SHARED = { watch_only: false, reason: "shared_pool" };

function restart() {
  _test.reset();
}

beforeEach(() => {
  stored = undefined;
  saveCalls = 0;
  saveFails = false;
  localHostId = "host-1";
  restart();
});

describe("parsePressurePolicyReply", () => {
  it("accepts exactly bound private and shared replies", () => {
    expect(parsePressurePolicyReply(reply(), "host-1", now)).toEqual({
      host_id: "host-1",
      watch_only: true,
      reason: "private_host",
      evaluated_at_ms: now,
      fetched_at_ms: now,
    });
    expect(
      parsePressurePolicyReply(reply(SHARED), "host-1", now)?.watch_only,
    ).toBe(false);
  });

  it.each([
    ["another host", { host_id: "host-2" }],
    ["a missing host id", { host_id: undefined }],
    ["a string watch_only", { watch_only: "true" }],
    ["a numeric watch_only", { watch_only: 1 }],
    ["an unknown reason", { reason: "dedicated" }],
    ["a reason that contradicts watch_only", { reason: "shared_pool" }],
    ["a missing evaluated_at", { evaluated_at: undefined }],
    ["a numeric evaluated_at", { evaluated_at: now }],
    ["an unparseable evaluated_at", { evaluated_at: "yesterday" }],
    ["an evaluated_at older than a day", { evaluated_at: iso(now - PRESSURE_POLICY_STALE_MS - 1) }],
    ["an evaluated_at in the future", { evaluated_at: iso(now + 5 * 60_000 + 1) }],
  ])("refuses %s", (_label, over) => {
    expect(parsePressurePolicyReply(reply(over), "host-1", now)).toBeUndefined();
  });

  it.each([null, undefined, "private", 42, [], [reply()]])(
    "refuses a non-object reply %p",
    (value) => {
      expect(parsePressurePolicyReply(value, "host-1", now)).toBeUndefined();
    },
  );

  it("refuses everything without a local host id", () => {
    expect(parsePressurePolicyReply(reply(), "", now)).toBeUndefined();
  });
});

describe("effective policy", () => {
  it("with an empty store, observes without acting until the bay answers", () => {
    expect(getEffectivePressurePolicy(now)).toEqual({
      watchOnly: true,
      tokens: ["policy_unknown"],
      refreshFailures: 0,
    });
  });

  it("the first accepted reply decides, and is stored", async () => {
    await expect(
      refreshPressurePolicy({ fetchReply: async () => reply(SHARED), now }),
    ).resolves.toBe(true);
    expect(getEffectivePressurePolicy(now)).toEqual({
      watchOnly: false,
      tokens: [],
      refreshFailures: 0,
    });
    expect(saveCalls).toBe(1);
  });

  it.each([
    ["an error", async () => Promise.reject(new Error("bay unreachable"))],
    ["a malformed reply", async () => reply({ watch_only: "yes" })],
    ["another host's reply", async () => reply({ host_id: "host-2" })],
  ])("keeps a known private policy after %s", async (_label, fetchReply) => {
    await refreshPressurePolicy({ fetchReply: async () => reply(), now });
    await expect(refreshPressurePolicy({ fetchReply, now })).resolves.toBe(false);
    const policy = getEffectivePressurePolicy(now);
    expect(policy.watchOnly).toBe(true);
    expect(policy.tokens).toEqual(["watch_only_private_host"]);
    expect(policy.refreshFailures).toBe(1);
    expect(saveCalls).toBe(1);
  });

  it("keeps a known shared policy after a failure (never flips to watch-only)", async () => {
    await refreshPressurePolicy({ fetchReply: async () => reply(SHARED), now });
    await refreshPressurePolicy({
      fetchReply: async () => Promise.reject(new Error("down")),
      now,
    });
    expect(getEffectivePressurePolicy(now).watchOnly).toBe(false);
  });

  it("a stale known policy keeps its value and is reported stale", async () => {
    await refreshPressurePolicy({ fetchReply: async () => reply(SHARED), now });
    const later = now + PRESSURE_POLICY_STALE_MS + 1;
    expect(getEffectivePressurePolicy(later)).toEqual({
      watchOnly: false,
      tokens: ["policy_stale"],
      refreshFailures: 0,
    });
    restart();
    stored = { ...stored, watch_only: true, reason: "private_host" };
    expect(getEffectivePressurePolicy(later).tokens).toEqual([
      "watch_only_private_host",
      "policy_stale",
    ]);
  });

  it("private to shared takes effect on the next accepted reply", async () => {
    await refreshPressurePolicy({ fetchReply: async () => reply(), now });
    expect(getEffectivePressurePolicy(now).watchOnly).toBe(true);
    await refreshPressurePolicy({
      fetchReply: async () => reply({ ...SHARED, evaluated_at: iso(now + 60_000) }),
      now: now + 60_000,
    });
    expect(getEffectivePressurePolicy(now + 60_000).watchOnly).toBe(false);
  });

  it.each([
    ["none", undefined, true, ["policy_unknown"]],
    ["private", { watch_only: true, reason: "private_host", evaluated_at_ms: now }, true, ["watch_only_private_host"]],
    ["shared", { watch_only: false, reason: "shared_pool", evaluated_at_ms: now }, false, []],
    ["stale private", { watch_only: true, reason: "private_host", evaluated_at_ms: now - PRESSURE_POLICY_STALE_MS - 1 }, true, ["watch_only_private_host", "policy_stale"]],
    ["stale shared", { watch_only: false, reason: "shared_pool", evaluated_at_ms: now - PRESSURE_POLICY_STALE_MS - 1 }, false, ["policy_stale"]],
  ])(
    "after a restart with a stored %s policy",
    (_label, row: any, watchOnly, tokens) => {
      stored = row && { host_id: "host-1", fetched_at_ms: now, ...row };
      restart();
      const policy = getEffectivePressurePolicy(now);
      expect(policy.watchOnly).toBe(watchOnly);
      expect(policy.tokens).toEqual(tokens);
    },
  );

  it("ignores a stored policy for another host id", () => {
    stored = {
      host_id: "old-host",
      watch_only: false,
      reason: "shared_pool",
      evaluated_at_ms: now,
      fetched_at_ms: now,
    };
    restart();
    expect(getEffectivePressurePolicy(now).tokens).toEqual(["policy_unknown"]);
  });

  it("ignores a malformed stored policy", () => {
    stored = { host_id: "host-1", watch_only: "no", reason: "shared_pool" };
    restart();
    expect(getEffectivePressurePolicy(now).tokens).toEqual(["policy_unknown"]);
  });

  it.each([
    ["known private, a shared reply", reply(), reply(SHARED), true, ["watch_only_private_host"]],
    ["known shared, a private reply", reply(SHARED), reply(), false, []],
    ["an empty store, a valid reply", undefined, reply(SHARED), true, ["policy_unknown"]],
  ])(
    "a reply that cannot be stored changes nothing (%s)",
    async (_label, known: any, next: any, watchOnly, tokens) => {
      if (known) {
        await refreshPressurePolicy({ fetchReply: async () => known, now });
      }
      const storedBefore = stored;
      saveFails = true;
      await expect(
        refreshPressurePolicy({ fetchReply: async () => next, now }),
      ).resolves.toBe(false);
      const policy = getEffectivePressurePolicy(now);
      expect(policy.watchOnly).toBe(watchOnly);
      expect(policy.tokens).toEqual(tokens);
      expect(policy.refreshFailures).toBe(1);
      expect(stored).toEqual(storedBefore);
      // a later refresh that can be stored installs the reply
      saveFails = false;
      await expect(
        refreshPressurePolicy({ fetchReply: async () => next, now }),
      ).resolves.toBe(true);
      expect(getEffectivePressurePolicy(now).watchOnly).toBe(next.watch_only);
      expect(stored?.watch_only).toBe(next.watch_only);
    },
  );

  it("loads the stored policy once the host knows its id", () => {
    stored = {
      host_id: "host-1",
      watch_only: false,
      reason: "shared_pool",
      evaluated_at_ms: now,
      fetched_at_ms: now,
    };
    localHostId = undefined;
    restart();
    // no id yet: nothing can be matched, so the policy is unknown for now
    expect(getEffectivePressurePolicy(now).tokens).toEqual(["policy_unknown"]);
    localHostId = "host-1";
    // the next read loads the stored shared policy instead of staying unknown
    const policy = getEffectivePressurePolicy(now);
    expect(policy.watchOnly).toBe(false);
    expect(policy.tokens).toEqual([]);
  });
});
