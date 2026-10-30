/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  applyProjectFundingMessage,
  canonicalProjectFundingTerms,
  mergeProjectFundingRoute,
  normalizeProjectFundingTerms,
  projectFundingDisplay,
  ProjectFundingError,
  routeMayHavePods,
  type ProjectFundingDisplay,
  type ProjectFundingRoute,
} from "./project-funding";

const A = "00000000-1000-4000-8000-00000000000a";
const LAYER = "00000000-1000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-01T12:00:00Z");
const DISPLAY: ProjectFundingDisplay = {
  authorized_usd: "400",
  ends_at: "2026-11-08T12:00:00.000Z",
  agents_allowed: true,
};

function pending(over: Partial<ProjectFundingRoute> = {}): ProjectFundingRoute {
  return {
    approval_id: A,
    state: "pending",
    version: 1,
    layer_id: null,
    lease_expires_at: new Date(NOW.getTime() + 60_000),
    ended_reason: null,
    ended_at: null,
    live_pods: 0,
    pods_version: 0,
    display: DISPLAY,
    ...over,
  };
}

const activate = {
  kind: "activate" as const,
  approval_id: A,
  version: 2,
  layer_id: LAYER,
  display: DISPLAY,
};

describe("normalizeProjectFundingTerms", () => {
  const ok = {
    provider: "runpod",
    authorized_usd: "400",
    days: 7,
    agents_allowed: true,
  };

  it("accepts minimal terms and drops unknown fields", () => {
    const t = normalizeProjectFundingTerms({ ...ok, evil: 1 });
    expect(Object.keys(t).sort()).toEqual([
      "agents_allowed",
      "authorized_usd",
      "days",
      "provider",
    ]);
    expect(Number(t.authorized_usd)).toBe(400);
  });

  it("refuses floats, zero, too many days, and other providers", () => {
    for (const bad of [
      { ...ok, authorized_usd: 400 },
      { ...ok, authorized_usd: "0" },
      { ...ok, authorized_usd: "1.234" },
      { ...ok, authorized_usd: "100001" },
      { ...ok, days: 121 },
      { ...ok, days: 0 },
      { ...ok, days: 1.5 },
      { ...ok, provider: "lambda" },
      { ...ok, agents_allowed: "yes" },
      { ...ok, cloud: "MOON" },
      { ...ok, allowed_gpu_type_ids: [] },
    ]) {
      expect(() => normalizeProjectFundingTerms(bad)).toThrow(
        ProjectFundingError,
      );
    }
  });

  it("canonicalizes for hashing: key order and GPU type order don't matter", () => {
    const a = canonicalProjectFundingTerms({
      ...ok,
      allowed_gpu_type_ids: ["B", "A", "A"],
      max_concurrent_pods: 2,
    } as any);
    const b = canonicalProjectFundingTerms({
      max_concurrent_pods: 2,
      allowed_gpu_type_ids: ["A", "B"],
      agents_allowed: true,
      days: 7,
      authorized_usd: "400.00",
      provider: "runpod",
    } as any);
    expect(a).toBe(b);
  });
});

describe("normalized terms compose (validate once, hash later)", () => {
  const terms = {
    provider: "runpod",
    authorized_usd: "400",
    max_hourly_usd: "12.5",
    days: 7,
    agents_allowed: false,
  };

  it("accepts its own output: normalize is idempotent", () => {
    const once = normalizeProjectFundingTerms(terms);
    expect(normalizeProjectFundingTerms(once)).toEqual(once);
  });

  it("canonicalizes already-normalized money fields to the same string", () => {
    const once = normalizeProjectFundingTerms(terms);
    expect(once.authorized_usd).toMatch(/^400\.0+$/);
    expect(once.max_hourly_usd).toMatch(/^12\.50+$/);
    expect(canonicalProjectFundingTerms(once)).toBe(
      canonicalProjectFundingTerms(terms as any),
    );
  });

  it("still refuses sub-cent amounts written with trailing zeros", () => {
    for (const bad of ["1.2340000000", "0.001"]) {
      expect(() =>
        normalizeProjectFundingTerms({ ...terms, authorized_usd: bad }),
      ).toThrow(ProjectFundingError);
      expect(() =>
        normalizeProjectFundingTerms({ ...terms, max_hourly_usd: bad }),
      ).toThrow(ProjectFundingError);
    }
  });
});

describe("projectFundingDisplay", () => {
  it("carries every approved cap, so P can show the actual terms", () => {
    const d = projectFundingDisplay(
      {
        provider: "runpod",
        authorized_usd: "400",
        days: 7,
        agents_allowed: true,
        max_hourly_usd: "5",
        max_concurrent_pods: 2,
        max_gpu_count: 4,
        max_runtime_minutes: 120,
        allowed_gpu_type_ids: ["NVIDIA A100 80GB PCIe"],
        cloud: "SECURE",
      },
      new Date("2026-11-08T12:00:00Z"),
      "Ada",
    );
    expect(d).toMatchObject({
      ends_at: "2026-11-08T12:00:00.000Z",
      agents_allowed: true,
      funder_name: "Ada",
      max_concurrent_pods: 2,
      max_gpu_count: 4,
      max_runtime_minutes: 120,
      allowed_gpu_type_ids: ["NVIDIA A100 80GB PCIe"],
      cloud: "SECURE",
    });
    expect(Number(d.authorized_usd)).toBe(400);
    expect(Number(d.max_hourly_usd)).toBe(5);
  });

  it("leaves out caps that weren't set", () => {
    const d = projectFundingDisplay(
      {
        provider: "runpod",
        authorized_usd: "50",
        days: 1,
        agents_allowed: false,
      },
      new Date("2026-11-02T00:00:00Z"),
    );
    expect(Object.keys(d).sort()).toEqual([
      "agents_allowed",
      "authorized_usd",
      "ends_at",
    ]);
  });

  it("travels whole in activate and update messages", () => {
    const display = projectFundingDisplay(
      {
        provider: "runpod",
        authorized_usd: "400",
        days: 7,
        agents_allowed: true,
        max_gpu_count: 4,
        allowed_gpu_type_ids: ["B", "A"],
        cloud: "COMMUNITY",
      },
      new Date("2026-11-08T12:00:00Z"),
    );
    const active = applyProjectFundingMessage(
      pending(),
      { ...activate, display },
      NOW,
    ).route;
    expect(active.display).toEqual(display);
    const updated = applyProjectFundingMessage(
      active,
      {
        kind: "update",
        approval_id: A,
        version: 3,
        display: { ...display, max_gpu_count: 2 },
      },
      NOW,
    ).route;
    expect(updated.display).toMatchObject({
      max_gpu_count: 2,
      allowed_gpu_type_ids: ["A", "B"],
      cloud: "COMMUNITY",
    });
  });
});

describe("applyProjectFundingMessage", () => {
  it("activates a pending slot with a newer version", () => {
    const t = applyProjectFundingMessage(pending(), activate, NOW);
    expect(t.outcome).toBe("applied");
    expect(t.route).toMatchObject({
      state: "active",
      version: 2,
      layer_id: LAYER,
      lease_expires_at: null,
    });
  });

  it("treats a repeated activate as stale (an ack), not a change", () => {
    const active = applyProjectFundingMessage(pending(), activate, NOW).route;
    expect(applyProjectFundingMessage(active, activate, NOW)).toEqual({
      outcome: "stale",
      route: active,
    });
  });

  it("ends a pending slot whose lease ran out instead of activating it", () => {
    const t = applyProjectFundingMessage(
      pending({ lease_expires_at: new Date(NOW.getTime() - 1) }),
      activate,
      NOW,
    );
    expect(t.outcome).toBe("lease_expired");
    expect(t.route).toMatchObject({
      state: "ended",
      ended_reason: "lease_expired",
    });
  });

  it("never resurrects an ended route: a delayed activate or update is stale", () => {
    const ended = pending({
      state: "ended",
      version: 5,
      ended_reason: "revoked",
      ended_at: NOW,
      lease_expires_at: null,
    });
    for (const msg of [
      { ...activate, version: 9 },
      { kind: "update" as const, approval_id: A, version: 9, display: DISPLAY },
    ]) {
      expect(applyProjectFundingMessage(ended, msg, NOW).outcome).toBe("stale");
    }
  });

  it("ignores an update older than the route (reordered delivery)", () => {
    const active = applyProjectFundingMessage(pending(), activate, NOW).route;
    const v4 = applyProjectFundingMessage(
      active,
      {
        kind: "update",
        approval_id: A,
        version: 4,
        display: { ...DISPLAY, agents_allowed: false },
      },
      NOW,
    ).route;
    const late = applyProjectFundingMessage(
      v4,
      { kind: "update", approval_id: A, version: 3, display: DISPLAY },
      NOW,
    );
    expect(late.outcome).toBe("stale");
    expect(late.route.display?.agents_allowed).toBe(false);
  });

  it("applies locator updates after the approval ended, by their own version", () => {
    const ended = applyProjectFundingMessage(
      applyProjectFundingMessage(pending(), activate, NOW).route,
      {
        kind: "end",
        approval_id: A,
        version: 3,
        reason: "revoked",
        live_pods: 1,
        pods_version: 2,
      },
      NOW,
    ).route;
    expect(ended).toMatchObject({ state: "ended", live_pods: 1 });
    expect(routeMayHavePods(ended)).toBe(true);
    const gone = applyProjectFundingMessage(
      ended,
      { kind: "pods", approval_id: A, live_pods: 0, pods_version: 3 },
      NOW,
    ).route;
    expect(gone.live_pods).toBe(0);
    expect(routeMayHavePods(gone)).toBe(false);
    // an older locator never brings a stale count back
    expect(
      applyProjectFundingMessage(
        gone,
        { kind: "pods", approval_id: A, live_pods: 1, pods_version: 2 },
        NOW,
      ).outcome,
    ).toBe("stale");
  });

  it("keeps an end's newer locator even when the end itself is stale", () => {
    const ended = pending({
      state: "ended",
      version: 3,
      ended_reason: "revoked",
      ended_at: NOW,
      lease_expires_at: null,
      live_pods: 0,
      pods_version: 1,
    });
    const t = applyProjectFundingMessage(
      ended,
      {
        kind: "end",
        approval_id: A,
        version: 3,
        reason: "revoked",
        live_pods: 1,
        pods_version: 2,
      },
      NOW,
    );
    expect(t.outcome).toBe("applied");
    expect(t.route).toMatchObject({ live_pods: 1, pods_version: 2 });
  });

  it("covers an end arriving before the pod-start locator event", () => {
    // the pod started (pods_version 1) but that message is still in flight;
    // the end carries the newer locator, so the route stays reachable
    const active = applyProjectFundingMessage(pending(), activate, NOW).route;
    const ended = applyProjectFundingMessage(
      active,
      {
        kind: "end",
        approval_id: A,
        version: 3,
        reason: "revoked",
        live_pods: 1,
        pods_version: 1,
      },
      NOW,
    ).route;
    expect(routeMayHavePods(ended)).toBe(true);
    const lateStart = applyProjectFundingMessage(
      ended,
      { kind: "pods", approval_id: A, live_pods: 1, pods_version: 1 },
      NOW,
    );
    expect(lateStart.outcome).toBe("stale");
  });

  it("refuses a message for another approval", () => {
    expect(() =>
      applyProjectFundingMessage(
        pending(),
        { ...activate, approval_id: LAYER },
        NOW,
      ),
    ).toThrow(ProjectFundingError);
  });
});

describe("mergeProjectFundingRoute (project rehome)", () => {
  it("takes the approval part and the locator from their own newer versions", () => {
    const destination = pending({
      state: "active",
      version: 4,
      layer_id: LAYER,
      lease_expires_at: null,
      live_pods: 0,
      pods_version: 1,
    });
    const copied = pending({
      state: "active",
      version: 2,
      layer_id: LAYER,
      lease_expires_at: null,
      live_pods: 2,
      pods_version: 3,
    });
    expect(mergeProjectFundingRoute(destination, copied)).toMatchObject({
      version: 4,
      live_pods: 2,
      pods_version: 3,
    });
  });

  it("is idempotent", () => {
    const r = pending();
    const once = mergeProjectFundingRoute(undefined, r);
    expect(mergeProjectFundingRoute(once, r)).toEqual(once);
  });

  it("lets an ended route win a tie with a nonterminal one", () => {
    const active = pending({ state: "active", version: 3, layer_id: LAYER });
    const ended = pending({
      state: "ended",
      version: 3,
      ended_reason: "revoked",
      ended_at: NOW,
    });
    expect(mergeProjectFundingRoute(active, ended).state).toBe("ended");
    expect(mergeProjectFundingRoute(ended, active).state).toBe("ended");
  });
});
