import {
  canonicalAbsolutePath,
  directPolicyDefaults,
  MAX_SESSION_SECONDS,
  parseComputerPolicy,
  parseRequestedPolicy,
  resolvedPolicyMismatches,
  policyAtMost,
  policyWideningReasons,
  PolicyError,
  type ComputerPolicy,
  leaseRule,
} from "./policy";

const NETWORK = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function isolated(overrides: Partial<ComputerPolicy> = {}): ComputerPolicy {
  return parseComputerPolicy({
    version: 1,
    mode: "isolated",
    duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
    lease_hours: 24,
    agent_network_id: NETWORK,
    network: "on",
    gpu: false,
    mounts: [
      { path: "/home/u/datasets", access: "ro", device: "2049", inode: "131" },
      { path: "/scratch", access: "rw", device: "2050", inode: "2" },
    ],
    images: { kind: "allow", refs: ["ubuntu:24.04", "python:3.13"] },
    scratch_bytes: 50 * 2 ** 30,
    limits: { cpu_millis: 8000, memory_bytes: 16 * 2 ** 30, pids: 4096 },
    ...overrides,
  });
}

describe("parseComputerPolicy", () => {
  it("normalizes: mounts sorted by path, image refs sorted and unique", () => {
    const p = isolated({
      images: {
        kind: "allow",
        refs: ["python:3.13", "ubuntu:24.04", "python:3.13"],
      },
    });
    expect(p.mounts.map((m) => m.path)).toEqual([
      "/home/u/datasets",
      "/scratch",
    ]);
    expect(p.images).toEqual({
      kind: "allow",
      refs: ["python:3.13", "ubuntu:24.04"],
    });
  });

  it("accepts a direct policy only at its widest", () => {
    const direct = parseComputerPolicy({
      version: 1,
      mode: "direct",
      duration: { initial_seconds: 3600, max_seconds: 3600 },
      lease_hours: 24,
      agent_network_id: NETWORK,
      ...directPolicyDefaults(),
    });
    expect(direct.mode).toBe("direct");
    // A read-only mount on a direct computer would be a promise we can't keep.
    expect(() =>
      parseComputerPolicy({
        ...direct,
        mounts: [{ path: "/data", access: "ro", device: "1", inode: "2" }],
      }),
    ).toThrow(PolicyError);
    expect(() => parseComputerPolicy({ ...direct, network: "off" })).toThrow(
      PolicyError,
    );
  });

  it("fails closed on unknown fields and versions", () => {
    const p: any = { ...isolated() };
    expect(() => parseComputerPolicy({ ...p, sudo: true })).toThrow(
      /unknown field/,
    );
    expect(() => parseComputerPolicy({ ...p, version: 2 })).toThrow(/version/);
    const { gpu: _gpu, ...missing } = p;
    expect(() => parseComputerPolicy(missing)).toThrow(/missing 'gpu'/);
  });

  it("bounds time limits to 8 hours and needs initial <= max", () => {
    expect(() =>
      isolated({
        duration: {
          initial_seconds: 3600,
          max_seconds: MAX_SESSION_SECONDS + 1,
        },
      }),
    ).toThrow(/8 hours/);
    expect(() =>
      isolated({ duration: { initial_seconds: 7200, max_seconds: 3600 } }),
    ).toThrow(/initial_seconds/);
    expect(isolated({ duration: null }).duration).toBeNull();
  });

  it("refuses duplicate mount paths and bad images", () => {
    const m = { path: "/a", access: "ro", device: "1", inode: "1" } as const;
    expect(() => isolated({ mounts: [m, { ...m, access: "rw" }] })).toThrow(
      /twice/,
    );
    expect(() =>
      isolated({ images: { kind: "allow", refs: ["UPPER/case"] } }),
    ).toThrow(/image reference/);
    expect(() =>
      isolated({ images: { kind: "allow", refs: ["ubuntu; rm -rf /"] } }),
    ).toThrow(/image reference/);
    expect(
      isolated({
        images: {
          kind: "allow",
          refs: [
            `ghcr.io/org/img:1.0@sha256:${"a".repeat(64)}`,
            "localhost:5000/x",
          ],
        },
      }).images,
    ).toEqual({
      kind: "allow",
      refs: [
        `ghcr.io/org/img:1.0@sha256:${"a".repeat(64)}`,
        "localhost:5000/x",
      ],
    });
  });
});

describe("the hard lease", () => {
  it("is a required whole number of hours from 1 to 8760", () => {
    expect(isolated().lease_hours).toBe(24);
    expect(isolated({ lease_hours: 1 }).lease_hours).toBe(1);
    expect(isolated({ lease_hours: 8760 }).lease_hours).toBe(8760);
    for (const bad of [0, -1, 8761, 1.5, "24", null]) {
      expect(() => isolated({ lease_hours: bad as any })).toThrow(
        /lease_hours/,
      );
    }
    const { lease_hours: _, ...missing } = isolated();
    expect(() => parseComputerPolicy(missing)).toThrow(/lease_hours/);
  });

  it("a shorter lease is narrower; a longer one widens", () => {
    const ceiling = isolated({ lease_hours: 24 });
    expect(policyAtMost(isolated({ lease_hours: 2 }), ceiling)).toBe(true);
    expect(
      policyWideningReasons(isolated({ lease_hours: 48 }), ceiling),
    ).toEqual(["the lease is longer than the ceiling's"]);
  });

  it("is said the same way everywhere", () => {
    expect(leaseRule(24)).toBe(
      "If this computer can't connect to CoCalc for 24 hours, all its jobs stop. It runs work again once it reconnects.",
    );
    expect(leaseRule(1)).toMatch(/for 1 hour,/);
  });
});

describe("canonicalAbsolutePath", () => {
  it.each([
    "/",
    "relative",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "/a/",
    "",
    "/a\u0000b",
  ])("refuses %j", (path) => {
    expect(() => canonicalAbsolutePath(path)).toThrow(PolicyError);
  });
  it("accepts canonical absolute paths", () => {
    expect(canonicalAbsolutePath("/Users/w/data sets")).toBe(
      "/Users/w/data sets",
    );
  });
});

describe("policy partial order (the daemon's 'never widen' rule)", () => {
  const ceiling = isolated();

  it("a policy is at most itself", () => {
    expect(policyWideningReasons(ceiling, ceiling)).toEqual([]);
  });

  it("allows every narrowing", () => {
    const narrower = isolated({
      duration: { initial_seconds: 1800, max_seconds: 3600 },
      network: "off",
      mounts: [{ path: "/scratch", access: "rw", device: "2050", inode: "2" }],
      images: { kind: "allow", refs: ["ubuntu:24.04"] },
      scratch_bytes: 2 ** 30,
      limits: { cpu_millis: 1000, memory_bytes: 2 ** 30, pids: 100 },
    });
    expect(policyAtMost(narrower, ceiling)).toBe(true);
    // rw -> ro is narrower too
    const readOnly = isolated({
      mounts: [{ path: "/scratch", access: "ro", device: "2050", inode: "2" }],
    });
    expect(policyAtMost(readOnly, ceiling)).toBe(true);
  });

  it.each<[string, Partial<ComputerPolicy>, RegExp]>([
    ["no time limit", { duration: null }, /time limit/],
    [
      "a longer initial time",
      { duration: { initial_seconds: 7200, max_seconds: 8 * 3600 } },
      /time limit/,
    ],
    ["a GPU", { gpu: true }, /GPU/],
    [
      "another network",
      { agent_network_id: "11111111-2222-4333-8444-555555555555" },
      /agent network/,
    ],
    ["any image", { images: { kind: "any" } }, /image/],
    [
      "another image",
      { images: { kind: "allow", refs: ["alpine:3"] } },
      /image/,
    ],
    ["no scratch quota", { scratch_bytes: null }, /scratch/],
    [
      "more memory",
      { limits: { cpu_millis: 8000, memory_bytes: 2 ** 40, pids: 4096 } },
      /memory_bytes/,
    ],
    [
      "no pid limit",
      { limits: { cpu_millis: 8000, memory_bytes: 16 * 2 ** 30, pids: null } },
      /pids/,
    ],
  ])("refuses %s", (_label, overrides, reason) => {
    const candidate = isolated(overrides);
    const reasons = policyWideningReasons(candidate, ceiling);
    expect(reasons.join("; ")).toMatch(reason);
  });

  it("refuses widening a mount, adding one, or the same path resolving elsewhere", () => {
    const rw = isolated({
      mounts: [
        {
          path: "/home/u/datasets",
          access: "rw",
          device: "2049",
          inode: "131",
        },
      ],
    });
    expect(policyWideningReasons(rw, ceiling).join()).toMatch(/read-only/);
    const added = isolated({
      mounts: [{ path: "/etc", access: "ro", device: "2049", inode: "7" }],
    });
    expect(policyWideningReasons(added, ceiling).join()).toMatch(
      /not in the ceiling/,
    );
    const swapped = isolated({
      mounts: [
        {
          path: "/home/u/datasets",
          access: "ro",
          device: "2049",
          inode: "999",
        },
      ],
    });
    expect(policyWideningReasons(swapped, ceiling).join()).toMatch(
      /not in the ceiling/,
    );
  });

  it("refuses network on under an off ceiling, and direct under isolated", () => {
    const off = isolated({ network: "off" });
    expect(policyAtMost(isolated(), off)).toBe(false);
    const direct = parseComputerPolicy({
      version: 1,
      mode: "direct",
      duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
      lease_hours: 24,
      agent_network_id: NETWORK,
      ...directPolicyDefaults(),
    });
    expect(policyWideningReasons(direct, ceiling).join()).toMatch(
      /direct mode/,
    );
    // ...while isolated is at most direct
    expect(policyAtMost(isolated(), direct)).toBe(true);
  });
});

describe("requested policies", () => {
  const request = {
    version: 1,
    mode: "isolated",
    duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
    lease_hours: 24,
    agent_network_id: NETWORK,
    network: "on",
    gpu: false,
    mounts: [{ path: "~/datasets", access: "ro" }],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  };

  it("accepts ~ paths and refuses the whole home or relative paths", () => {
    expect(parseRequestedPolicy(request).mounts).toEqual([
      { path: "~/datasets", access: "ro" },
    ]);
    expect(() =>
      parseRequestedPolicy({
        ...request,
        mounts: [{ path: "~", access: "ro" }],
      }),
    ).toThrow(/home/);
    expect(() =>
      parseRequestedPolicy({
        ...request,
        mounts: [{ path: "datasets", access: "ro" }],
      }),
    ).toThrow(PolicyError);
    expect(() =>
      parseRequestedPolicy({
        ...request,
        mounts: [{ path: "~/a/../b", access: "ro" }],
      }),
    ).toThrow(PolicyError);
  });

  it("matches a resolved policy that only resolves the mounts", () => {
    const requested = parseRequestedPolicy(request);
    const resolved = parseComputerPolicy({
      ...request,
      mounts: [
        {
          path: "/Users/w/datasets",
          access: "ro",
          device: "16777230",
          inode: "42",
        },
      ],
    });
    expect(resolvedPolicyMismatches(requested, resolved)).toEqual([]);
  });

  it("reports a resolved policy that changes anything else", () => {
    const requested = parseRequestedPolicy(request);
    const widened = parseComputerPolicy({
      ...request,
      gpu: true,
      mounts: [
        { path: "/Users/w/datasets", access: "rw", device: "1", inode: "2" },
      ],
    });
    const reasons = resolvedPolicyMismatches(requested, widened).join("; ");
    expect(reasons).toMatch(/gpu differs/);
    expect(reasons).toMatch(/mounts differ/);
  });

  it("the machine can't change the lease it was asked for", () => {
    const requested = parseRequestedPolicy(request);
    const longer = parseComputerPolicy({
      ...request,
      lease_hours: 8760,
      mounts: [],
    });
    expect(resolvedPolicyMismatches(requested, longer).join("; ")).toMatch(
      /lease_hours differs/,
    );
  });
});
