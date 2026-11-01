/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import {
  TRIVY_DB_LAYER_MEDIA_TYPE,
  TRIVY_DB_LIMITS,
  TRIVY_DB_SOURCE_FILE,
  assertAllowedUrl,
  extractTrivyDbArchive,
  fetchTrivyDb,
  guardedGet,
  guardedLookup,
  httpsTransport,
  isForbiddenAddress,
  trivyDbIsFresh,
  validTrivyDbProvenance,
  withTrivyCacheLock,
  type Transport,
} from "./rootfs-scan-db";

const tempDirs: string[] = [];
async function mkTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rootfs-scan-db-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// A ustar header for one entry.
function tarHeader(
  name: string,
  size: number,
  { type = "0", prefix = "", linkname = "" } = {},
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

type Entry = {
  name: string;
  content?: Buffer | string;
  type?: string;
  prefix?: string;
  linkname?: string;
  size?: number;
};

function tarball(entries: Entry[], { trailer = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    parts.push(
      tarHeader(entry.name, entry.size ?? content.length, {
        type: entry.type,
        prefix: entry.prefix,
        linkname: entry.linkname,
      }),
    );
    if (content.length) {
      parts.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  if (trailer) parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const METADATA = JSON.stringify({
  Version: 2,
  UpdatedAt: "2026-11-01T00:00:00Z",
});
const goodArchive = () =>
  tarball([
    { name: "trivy.db", content: "the database" },
    { name: "metadata.json", content: METADATA },
  ]);

describe("extractTrivyDbArchive", () => {
  it("extracts exactly trivy.db and metadata.json", async () => {
    const dir = await mkTempDir();
    await extractTrivyDbArchive(Readable.from([goodArchive()]), dir);
    expect((await readdir(dir)).sort()).toEqual(["metadata.json", "trivy.db"]);
    expect(await readFile(join(dir, "trivy.db"), "utf8")).toBe("the database");
  });

  const hostile: Array<[string, Entry[]]> = [
    ["a symlink", [{ name: "trivy.db", type: "2", linkname: "/etc/shadow" }]],
    [
      "a hardlink",
      [{ name: "trivy.db", type: "1", linkname: "metadata.json" }],
    ],
    ["a device", [{ name: "trivy.db", type: "3" }]],
    ["a directory", [{ name: "trivy.db", type: "5" }]],
    [
      "a pax header",
      [{ name: "pax", type: "x", content: "30 path=../../etc/cron.d/x\n" }],
    ],
    ["a parent path", [{ name: "../trivy.db", content: "x" }]],
    ["an absolute path", [{ name: "/trivy.db", content: "x" }]],
    ["a ustar prefix", [{ name: "trivy.db", prefix: "..", content: "x" }]],
    [
      "an extra entry",
      [
        { name: "trivy.db", content: "x" },
        { name: "metadata.json", content: METADATA },
        { name: "evil.sh", content: "x" },
      ],
    ],
    [
      "a repeated entry",
      [
        { name: "trivy.db", content: "x" },
        { name: "trivy.db", content: "y" },
      ],
    ],
    [
      "an oversized entry",
      [{ name: "metadata.json", size: TRIVY_DB_LIMITS.maxMetadataBytes + 1 }],
    ],
    ["a missing entry", [{ name: "trivy.db", content: "x" }]],
    ...[
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ].map((name): [string, Entry[]] => [
      `an entry named ${name}`,
      [{ name, content: "x".repeat(4096) }],
    ]),
  ];
  for (const [what, entries] of hostile) {
    it(`refuses ${what}, writing nothing outside its directory`, async () => {
      const base = await mkTempDir();
      const dir = join(base, "db");
      await mkdir(dir);
      await expect(
        extractTrivyDbArchive(Readable.from([tarball(entries)]), dir),
      ).rejects.toThrow(/Trivy DB archive/);
      expect(await readdir(base)).toEqual(["db"]);
    });
  }

  it("refuses a header with a bad checksum", async () => {
    const raw = Buffer.concat([tarHeader("trivy.db", 0), Buffer.alloc(1024)]);
    raw[0] = "x".charCodeAt(0);
    await expect(
      extractTrivyDbArchive(Readable.from([gzipSync(raw)]), await mkTempDir()),
    ).rejects.toThrow("checksum");
  });

  it("refuses data after the end of the archive", async () => {
    const raw = Buffer.concat([
      tarHeader("trivy.db", 0),
      tarHeader("metadata.json", 0),
      Buffer.alloc(512),
      tarHeader("evil.sh", 0),
    ]);
    await expect(
      extractTrivyDbArchive(Readable.from([gzipSync(raw)]), await mkTempDir()),
    ).rejects.toThrow("after the end");
  });

  it("requires a complete end-of-archive marker and nothing after it", async () => {
    const entries = Buffer.concat([
      tarHeader("trivy.db", 0),
      tarHeader("metadata.json", 0),
    ]);
    for (const [, raw, message] of [
      ["no terminator", entries, "truncated"],
      [
        "one zero block",
        Buffer.concat([entries, Buffer.alloc(512)]),
        "truncated",
      ],
      [
        "short trailing data",
        Buffer.concat([entries, Buffer.alloc(1024), Buffer.from("junk")]),
        "after the end",
      ],
    ] as const) {
      await expect(
        extractTrivyDbArchive(
          Readable.from([gzipSync(raw)]),
          await mkTempDir(),
        ),
      ).rejects.toThrow(message);
    }
  });

  it("refuses a decompression bomb", async () => {
    const saved = TRIVY_DB_LIMITS.maxDecompressedBytes;
    TRIVY_DB_LIMITS.maxDecompressedBytes = 64 * 1024;
    try {
      const archive = tarball([
        { name: "trivy.db", content: Buffer.alloc(1024 * 1024) },
        { name: "metadata.json", content: METADATA },
      ]);
      await expect(
        extractTrivyDbArchive(Readable.from([archive]), await mkTempDir()),
      ).rejects.toThrow("decompressed size");
    } finally {
      TRIVY_DB_LIMITS.maxDecompressedBytes = saved;
    }
  });
});

describe("network guards", () => {
  it("refuses forbidden addresses, including the metadata server", () => {
    for (const address of [
      "169.254.169.254",
      "10.138.0.22",
      "172.16.0.1",
      "192.168.1.1",
      "127.0.0.1",
      "0.0.0.0",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:a9fe:a9fe",
      "::a9fe:a9fe",
      "::169.254.169.254",
      "::ffff:0:a9fe:a9fe",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "2002:a9fe:a9fe::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "fe80::1%eth0",
      "not-an-address",
    ]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
    for (const address of [
      "140.82.112.34",
      "2607:f8b0:4004:c1b::52",
      "::ffff:140.82.112.34",
      "64:ff9b::8c52:7022",
    ]) {
      expect(isForbiddenAddress(address)).toBe(false);
    }
  });

  it("allows only https to the allowlisted registry hosts", () => {
    expect(assertAllowedUrl("https://ghcr.io/v2/x").hostname).toBe("ghcr.io");
    for (const url of [
      "http://ghcr.io/v2/x",
      "https://169.254.169.254/computeMetadata/v1/",
      "https://[::1]/",
      "https://10.0.0.1/",
      "https://evil.example/",
      "https://ghcr.io.evil.example/",
      "https://ghcr.io:8443/",
      "https://user:pw@ghcr.io/",
    ]) {
      expect(() => assertAllowedUrl(url)).toThrow(/refused/);
    }
  });

  it("refuses a hostname that resolves to a link-local address", (done) => {
    const lookup = guardedLookup((_host, _opts, cb) =>
      cb(null, [
        { address: "140.82.112.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    );
    lookup("ghcr.io", { all: true }, (err) => {
      expect(err?.code).toBe("EFORBIDDENADDRESS");
      done();
    });
  });

  it("never connects when DNS points an allowlisted host at the metadata server", async () => {
    for (const [address, family] of [
      ["169.254.169.254", 4],
      ["::ffff:a9fe:a9fe", 6],
      ["::a9fe:a9fe", 6],
      ["2002:a9fe:a9fe::1", 6],
    ] as const) {
      const transport = httpsTransport({
        resolve: (_host, _opts, cb) => cb(null, [{ address, family }]),
      });
      await expect(
        transport(new URL("https://ghcr.io/v2/"), {}),
      ).rejects.toMatchObject({ code: "EFORBIDDENADDRESS" });
    }
  });

  it("refuses IPv4-mapped and compatible forms of the metadata address in the lookup", (done) => {
    const lookup = guardedLookup((_host, _opts, cb) =>
      cb(null, [{ address: "::ffff:a9fe:a9fe", family: 6 }]),
    );
    lookup("ghcr.io", { all: true }, (err) => {
      expect(err?.code).toBe("EFORBIDDENADDRESS");
      done();
    });
  });

  function redirecting(locations: string[]): Transport & {
    seen: Array<{ url: string; headers: Record<string, string> }>;
  } {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let i = 0;
    const transport = (async (url: URL, headers: Record<string, string>) => {
      seen.push({ url: `${url}`, headers });
      const location = locations[i++];
      return location != null
        ? { status: 307, headers: { location }, body: Readable.from([]) }
        : { status: 200, headers: {}, body: Readable.from(["ok"]) };
    }) as Transport & { seen: typeof seen };
    transport.seen = seen;
    return transport;
  }

  for (const location of [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/computeMetadata/v1/",
    "https://[fd00::1]/",
    "https://evil.example/blob",
  ]) {
    it(`refuses a redirect to ${location}`, async () => {
      const transport = redirecting([location]);
      await expect(
        guardedGet("https://ghcr.io/v2/x", { transport }),
      ).rejects.toThrow(/refused/);
      expect(transport.seen).toHaveLength(1);
    });
  }

  it("caps the number of redirects", async () => {
    const hop = "https://ghcr.io/v2/next";
    const transport = redirecting([hop, hop, hop, hop, hop]);
    await expect(
      guardedGet("https://ghcr.io/v2/x", { transport }),
    ).rejects.toThrow("too many redirects");
  });

  it("doesn't send the registry token to the blob host it redirects to", async () => {
    const transport = redirecting([
      "https://pkg-containers.githubusercontent.com/ghcrblobs/blob",
    ]);
    await guardedGet("https://ghcr.io/v2/x", {
      headers: { Authorization: "Bearer t" },
      authHost: "ghcr.io",
      transport,
    });
    expect(transport.seen[0].headers.Authorization).toBe("Bearer t");
    expect(transport.seen[1].headers.Authorization).toBeUndefined();
  });
});

// A fake registry pair: mirror.gcr.io serves anonymously; ghcr.io wants an
// anonymous token and redirects blobs to its CDN host.
function fakeRegistries({
  archive = goodArchive(),
  layerDigest,
  mirrorFails = false,
}: { archive?: Buffer; layerDigest?: string; mirrorFails?: boolean } = {}) {
  const digest =
    layerDigest ??
    `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layers: [
        { mediaType: TRIVY_DB_LAYER_MEDIA_TYPE, digest, size: archive.length },
      ],
    }),
  );
  const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const requests: string[] = [];
  const reply = (status: number, body: Buffer | string = "", headers = {}) => ({
    status,
    headers,
    body: Readable.from([Buffer.from(body)]),
  });
  const transport: Transport = async (url, headers) => {
    requests.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === "mirror.gcr.io") {
      if (mirrorFails) return reply(503);
      if (url.pathname.endsWith("/manifests/2")) {
        return reply(200, manifest, {
          "docker-content-digest": manifestDigest,
        });
      }
      return reply(200, archive);
    }
    if (url.hostname === "ghcr.io") {
      if (url.pathname === "/token") {
        return reply(200, JSON.stringify({ token: "anon" }));
      }
      if (headers.Authorization !== "Bearer anon") {
        return reply(401, "", {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:aquasecurity/trivy-db:pull"',
        });
      }
      if (url.pathname.endsWith("/manifests/2")) return reply(200, manifest);
      return reply(307, "", {
        location: "https://pkg-containers.githubusercontent.com/ghcrblobs/x",
      });
    }
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      if (headers.Authorization) return reply(400, "token leaked");
      return reply(200, archive);
    }
    return reply(404);
  };
  return { transport, requests, manifestDigest, digest };
}

describe("fetchTrivyDb", () => {
  it("installs a verified database and records where it came from", async () => {
    const cache = await mkTempDir();
    const { transport, manifestDigest, digest } = fakeRegistries();
    const provenance = await fetchTrivyDb({
      trivy_cache_dir: cache,
      transport,
      now: () => new Date("2026-11-01T22:00:00Z"),
    });
    expect(provenance).toMatchObject({
      source: "mirror.gcr.io/aquasec/trivy-db:2",
      manifest_digest: manifestDigest,
      layer_digest: digest,
    });
    expect(provenance.integrity).toContain("advisory");
    expect((await readdir(join(cache, "db"))).sort()).toEqual([
      TRIVY_DB_SOURCE_FILE,
      "metadata.json",
      "trivy.db",
    ]);
    const metadata = JSON.parse(
      await readFile(join(cache, "db", "metadata.json"), "utf8"),
    );
    expect(metadata).toMatchObject({
      Version: 2,
      DownloadedAt: "2026-11-01T22:00:00.000Z",
    });
    // no staging or retired directories are left behind
    expect(await readdir(cache)).toEqual(["db"]);
  });

  it("removes the leftovers of an interrupted fetch", async () => {
    const cache = await mkTempDir();
    await mkdir(join(cache, ".db-staging-old", "db"), { recursive: true });
    await mkdir(join(cache, ".db-retired-old"));
    const { transport } = fakeRegistries();
    await fetchTrivyDb({ trivy_cache_dir: cache, transport });
    expect(await readdir(cache)).toEqual(["db"]);
  });

  it("falls back to ghcr.io with an anonymous token and its blob redirect", async () => {
    const cache = await mkTempDir();
    const { transport, requests } = fakeRegistries({ mirrorFails: true });
    const provenance = await fetchTrivyDb({
      trivy_cache_dir: cache,
      transport,
    });
    expect(provenance.source).toBe("ghcr.io/aquasecurity/trivy-db:2");
    expect(requests).toContain(
      "pkg-containers.githubusercontent.com/ghcrblobs/x",
    );
  });

  it("refuses a blob whose digest differs from the manifest, keeping the old database", async () => {
    const cache = await mkTempDir();
    await mkdir(join(cache, "db"));
    await writeFile(join(cache, "db", "metadata.json"), "old");
    const { transport } = fakeRegistries({
      layerDigest: `sha256:${"0".repeat(64)}`,
    });
    await expect(
      fetchTrivyDb({ trivy_cache_dir: cache, transport }),
    ).rejects.toThrow("digest mismatch");
    expect(await readFile(join(cache, "db", "metadata.json"), "utf8")).toBe(
      "old",
    );
    expect(await readdir(cache)).toEqual(["db"]);
  });

  it("refuses a hostile archive even when its digest matches", async () => {
    const cache = await mkTempDir();
    const { transport } = fakeRegistries({
      archive: tarball([
        { name: "trivy.db", type: "2", linkname: "/etc/passwd" },
      ]),
    });
    await expect(
      fetchTrivyDb({ trivy_cache_dir: cache, transport }),
    ).rejects.toThrow("not a regular file");
    expect(await readdir(cache)).toEqual([]);
  });

  it("puts the old database back when the swap fails", async () => {
    const cache = await mkTempDir();
    await mkdir(join(cache, "db"));
    await writeFile(join(cache, "db", "metadata.json"), "old");
    const { transport } = fakeRegistries();
    let calls = 0;
    const { rename } = await import("node:fs/promises");
    await expect(
      fetchTrivyDb({
        trivy_cache_dir: cache,
        transport,
        sources: [
          { registry: "mirror.gcr.io", repository: "aquasec/trivy-db" },
        ],
        renameDir: async (from, to) => {
          calls += 1;
          if (calls === 2) throw new Error("injected rename failure");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("injected rename failure");
    expect(await readFile(join(cache, "db", "metadata.json"), "utf8")).toBe(
      "old",
    );
    expect(await readdir(cache)).toEqual(["db"]);
  });

  it("recovers a swap interrupted between its renames", async () => {
    const cache = await mkTempDir();
    // a crash left no db/, only the retired old one
    await mkdir(join(cache, ".db-retired-abc"));
    await writeFile(join(cache, ".db-retired-abc", "metadata.json"), "old");
    const { transport } = fakeRegistries({ mirrorFails: true });
    await expect(
      fetchTrivyDb({
        trivy_cache_dir: cache,
        transport,
        sources: [
          { registry: "mirror.gcr.io", repository: "aquasec/trivy-db" },
        ],
      }),
    ).rejects.toThrow("fetch failed");
    expect(await readFile(join(cache, "db", "metadata.json"), "utf8")).toBe(
      "old",
    );
    expect(await readdir(cache)).toEqual(["db"]);
  });
});

describe("provenance", () => {
  const valid = {
    source: "ghcr.io/aquasecurity/trivy-db:2",
    manifest_digest: `sha256:${"a".repeat(64)}`,
    layer_digest: `sha256:${"b".repeat(64)}`,
    fetched_at: "2026-11-01T22:00:00.000Z",
    integrity: "advisory",
  };

  it("accepts exactly what the fetcher records", () => {
    expect(validTrivyDbProvenance(valid)).toEqual(valid);
    expect(validTrivyDbProvenance({ ...valid, extra: 1 })).toEqual(valid);
  });

  it("refuses malformed provenance", () => {
    for (const bad of [
      null,
      [],
      "x",
      { ...valid, source: "evil.example/trivy-db:2" },
      { ...valid, source: "ghcr.io/aquasecurity/trivy-db:latest" },
      { ...valid, manifest_digest: "sha256:abc" },
      { ...valid, layer_digest: `sha512:${"b".repeat(64)}` },
      { ...valid, fetched_at: "yesterday" },
      { ...valid, fetched_at: "2026-13-45T99:99:99Z" },
      { ...valid, integrity: "" },
      { ...valid, manifest_digest: undefined },
    ]) {
      expect(validTrivyDbProvenance(bad)).toBeUndefined();
    }
  });

  it("is fresh for a day after the fetch", () => {
    const fetched = Date.parse(valid.fetched_at);
    expect(trivyDbIsFresh(valid, fetched + 60_000)).toBe(true);
    expect(trivyDbIsFresh(valid, fetched + 25 * 60 * 60 * 1000)).toBe(false);
    expect(trivyDbIsFresh(valid, fetched - 60_000)).toBe(false);
    expect(trivyDbIsFresh(undefined)).toBe(false);
  });
});

describe("withTrivyCacheLock", () => {
  it("runs one task at a time per cache directory, also after a failure", async () => {
    const order: string[] = [];
    const task =
      (name: string, fail = false) =>
      async () => {
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end ${name}`);
        if (fail) throw new Error(name);
      };
    await Promise.allSettled([
      withTrivyCacheLock("/cache/a", task("1", true)),
      withTrivyCacheLock("/cache/a/", task("2")),
      withTrivyCacheLock("/cache/a", task("3")),
    ]);
    expect(order).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
    ]);
  });
});
