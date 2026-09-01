import {
  _test,
  readRusticCacheMaintenanceConfig,
  runRusticCacheSweep,
  type RusticCacheEntry,
  type RusticCacheMaintenanceConfig,
  type RusticCacheSweepDependencies,
} from "./rustic-cache-maintenance";

const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 18, 12);

function entry(
  name: string,
  bytes: number,
  ageHours: number,
): RusticCacheEntry {
  return {
    name,
    path: `/cache/${name}`,
    bytes,
    mtimeMs: NOW - ageHours * HOUR_MS,
  };
}

function config(
  overrides: Partial<RusticCacheMaintenanceConfig> = {},
): RusticCacheMaintenanceConfig {
  return {
    enabled: true,
    cacheRoot: "/cache",
    maxBytes: 4 * GIB,
    targetBytes: 3 * GIB,
    hardMaxBytes: 6 * GIB,
    minRootFreeBytes: 5 * GIB,
    targetRootFreeBytes: 6 * GIB,
    criticalRootFreeBytes: 2 * GIB,
    minEntryAgeMs: HOUR_MS,
    intervalMs: 10 * 60 * 1000,
    ...overrides,
  };
}

function dependencies({
  entries,
  rootAvailableBytes = 10 * GIB,
  active = [false],
}: {
  entries: RusticCacheEntry[];
  rootAvailableBytes?: number;
  active?: boolean[];
}): {
  dependencies: RusticCacheSweepDependencies;
  removed: string[];
} {
  const removed: string[] = [];
  let activeIndex = 0;
  return {
    removed,
    dependencies: {
      listEntries: async () => entries,
      rootAvailableBytes: async () => rootAvailableBytes,
      isRusticActive: async () =>
        active[Math.min(activeIndex++, active.length - 1)] ?? false,
      removeEntry: async (item) => {
        removed.push(item.name);
      },
      now: () => NOW,
    },
  };
}

describe("Rustic cache maintenance", () => {
  it("parses repository size and newest descendant time from du", () => {
    expect(
      _test.parseDirectoryUsage(
        "1751293952\t1787101858.053035092\t/cache/repo with spaces\n",
      ),
    ).toEqual({
      bytes: 1_751_293_952,
      mtimeMs: 1_787_101_858_053.035,
    });
  });

  it("rejects a cache root that could broaden recursive deletion", () => {
    const original = process.env.COCALC_RUSTIC_CACHE_DIR;
    process.env.COCALC_RUSTIC_CACHE_DIR = "/";
    try {
      expect(() => readRusticCacheMaintenanceConfig()).toThrow(
        "must name a rustic directory",
      );
    } finally {
      if (original == null) {
        delete process.env.COCALC_RUSTIC_CACHE_DIR;
      } else {
        process.env.COCALC_RUSTIC_CACHE_DIR = original;
      }
    }
  });

  it("preserves one backup cycle by default", () => {
    expect(readRusticCacheMaintenanceConfig().minEntryAgeMs).toBe(24 * HOUR_MS);
  });

  it("does nothing below both pressure thresholds", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("repo-a", GIB, 10), entry("repo-b", GIB, 8)],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual([]);
  });

  it("evicts oldest repositories until the lower cache watermark", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [
        entry("newest", 2 * GIB, 2),
        entry("oldest", GIB, 20),
        entry("middle", 2 * GIB, 10),
      ],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["oldest", "middle"]);
  });

  it("also evicts under root filesystem pressure", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("oldest", GIB, 20), entry("newest", GIB, 10)],
      rootAvailableBytes: 4.5 * GIB,
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["oldest", "newest"]);
  });

  it("shortens the age floor under warning-level root pressure", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("recent", 2 * GIB, 0.5)],
      rootAvailableBytes: 4.5 * GIB,
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["recent"]);
  });

  it("preserves cache from the current maintenance interval under warning pressure", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("in-flight-window", 2 * GIB, 0.1)],
      rootAvailableBytes: 4.5 * GIB,
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual([]);
  });

  it("does not evict while Rustic is active", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("repo-a", 5 * GIB, 10)],
      active: [true],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual([]);
  });

  it("stops if Rustic starts between repository evictions", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("oldest", GIB, 20), entry("newest", 4 * GIB, 10)],
      active: [false, false, true],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["oldest"]);
  });

  it("preserves recently used repositories outside critical pressure", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("recent", 5 * GIB, 0.5)],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual([]);
  });

  it("allows recent eviction when root free space is critical", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [entry("recent", GIB, 0.5)],
      rootAvailableBytes: GIB,
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["recent"]);
  });

  it("enforces the hard cache ceiling even when every repository is recent", async () => {
    const { dependencies: deps, removed } = dependencies({
      entries: [
        entry("recent-a", 4 * GIB, 0.25),
        entry("recent-b", 3 * GIB, 0.5),
      ],
    });

    await runRusticCacheSweep(config(), deps);

    expect(removed).toEqual(["recent-b", "recent-a"]);
  });
});
