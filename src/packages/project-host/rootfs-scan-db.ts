/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Fetches the Trivy vulnerability database for RootFS scans on the host.
//
// The scanner image only ever runs without a network and with a read-only
// cache; it never downloads anything.  The database (an OCI artifact,
// trivy-db:2) is fetched here instead:
//
// - HTTPS only, to an allowlist of registry hosts (redirects too); every
//   connection's resolved addresses are checked, so a hostname can't be
//   pointed at the metadata server, loopback or a private network;
// - every blob is verified against the digest in the manifest, and the
//   manifest digest is recorded with the database;
// - the archive is read by a strict tar reader that extracts exactly
//   trivy.db and metadata.json as regular files, with size caps, into a new
//   directory (O_EXCL files) that replaces the cache's db/ by rename.
//
// trivy-db:2 is a moving tag by design, so the database content is only as
// trustworthy as the registry: a poisoned database can falsify scan results
// (they are advisory), but it never runs code.

import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createReadStream, type WriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const TRIVY_DB_LAYER_MEDIA_TYPE =
  "application/vnd.aquasec.trivy.db.layer.v1.tar+gzip";

export type TrivyDbSource = { registry: string; repository: string };

// Where Trivy itself fetches its database from, in its default order.
export const TRIVY_DB_SOURCES: TrivyDbSource[] = [
  { registry: "mirror.gcr.io", repository: "aquasec/trivy-db" },
  { registry: "ghcr.io", repository: "aquasecurity/trivy-db" },
];
const TRIVY_DB_TAG = "2";

// Every host a request (or a redirect) may go to.
export const TRIVY_DB_ALLOWED_HOSTS = new Set([
  "mirror.gcr.io",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
]);

export const TRIVY_DB_LIMITS = {
  maxRedirects: 3,
  maxManifestBytes: 64 * 1024,
  maxTokenBytes: 64 * 1024,
  maxCompressedBytes: 1024 * 1024 * 1024,
  maxDbBytes: 8 * 1024 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024 * 1024 + 1024 * 1024,
  requestTimeoutMs: 60_000,
};

// The database files the cache must contain, and nothing else, with their
// size caps.  A Map: a name from the archive must never match a property of
// Object.prototype (constructor, __proto__, ...).
const DB_ENTRIES = new Map<string, number>([
  ["trivy.db", TRIVY_DB_LIMITS.maxDbBytes],
  ["metadata.json", TRIVY_DB_LIMITS.maxMetadataBytes],
]);

// The database is refreshed when older than this (it changes upstream every
// few hours; the background job used to refresh it daily).
export const TRIVY_DB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function trivyDbIsFresh(
  provenance: TrivyDbProvenance | undefined,
  now: number = Date.now(),
  maxAgeMs: number = TRIVY_DB_MAX_AGE_MS,
): boolean {
  if (provenance == null) return false;
  const age = now - Date.parse(provenance.fetched_at);
  return age >= 0 && age < maxAgeMs;
}

// Recorded next to the database; scans report it with their results.
export const TRIVY_DB_SOURCE_FILE = "cocalc-db-source.json";

export type TrivyDbProvenance = {
  source: string;
  manifest_digest: string;
  layer_digest: string;
  fetched_at: string;
  integrity: string;
};

const FORBIDDEN_ADDRESSES = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  FORBIDDEN_ADDRESSES.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const) {
  FORBIDDEN_ADDRESSES.addSubnet(net, prefix, "ipv6");
}

// The 16 bytes of an IPv6 address (with an optional zone, and an optional
// dotted IPv4 tail), or undefined if it isn't one.
export function ipv6Bytes(address: string): number[] | undefined {
  let text = address.split("%", 1)[0];
  if (isIP(text) !== 6) return undefined;
  let tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail = dotted[1].split(".").map(Number);
    text = `${text.slice(0, dotted.index)}:0:0`;
  }
  const [head, rest] = text.includes("::")
    ? text.split("::")
    : [text, undefined];
  const parse = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const front = parse(head);
  const back = rest == null ? [] : parse(rest);
  const groups =
    rest == null
      ? front
      : [
          ...front,
          ...new Array(8 - front.length - back.length).fill(0),
          ...back,
        ];
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) {
    return undefined;
  }
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (dotted) bytes.splice(12, 4, ...tail);
  return bytes;
}

const startsWith = (bytes: number[], prefix: number[]) =>
  prefix.every((byte, i) => bytes[i] === byte);

// Whether a connection to this address is refused: loopback, link-local
// (the metadata server), private, shared and reserved ranges.  IPv6 forms
// that carry an IPv4 address (mapped, compatible, SIIT, NAT64) get the IPv4
// rules, and IPv6 tunnels (6to4, Teredo, local NAT64) are refused outright,
// so the result never depends on how the runtime treats them.
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return FORBIDDEN_ADDRESSES.check(address, "ipv4");
  const bytes = ipv6Bytes(address);
  if (bytes == null) return true;
  const embedded = (offset: number) =>
    isForbiddenAddress(bytes.slice(offset, offset + 4).join("."));
  const zeros = (n: number) => new Array(n).fill(0);
  if (startsWith(bytes, [...zeros(10), 0xff, 0xff])) return embedded(12); // ::ffff:0:0/96
  if (startsWith(bytes, zeros(12))) return embedded(12); // ::/96 (incl. :: and ::1)
  if (startsWith(bytes, [...zeros(8), 0xff, 0xff, 0, 0])) return embedded(12); // ::ffff:0:0:0/96
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, ...zeros(8)]))
    return embedded(12); // 64:ff9b::/96
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) return true; // 64:ff9b:1::/48
  if (startsWith(bytes, [0x20, 0x02])) return true; // 6to4 2002::/16
  if (startsWith(bytes, [0x20, 0x01, 0, 0])) return true; // Teredo 2001::/32
  const canonical = [0, 2, 4, 6, 8, 10, 12, 14]
    .map((i) => ((bytes[i] << 8) | bytes[i + 1]).toString(16))
    .join(":");
  return FORBIDDEN_ADDRESSES.check(canonical, "ipv6");
}

// The URL as one a request may go to, or an error: https, port 443, an
// allowlisted hostname (never an address literal), no credentials.
export function assertAllowedUrl(raw: string | URL): URL {
  const url = new URL(`${raw}`);
  if (url.protocol !== "https:") {
    throw new Error(`Trivy DB fetch refused non-https URL ${url.origin}`);
  }
  if (url.port !== "" && url.port !== "443") {
    throw new Error(`Trivy DB fetch refused port ${url.port}`);
  }
  if (url.username || url.password) {
    throw new Error("Trivy DB fetch refused a URL with credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    throw new Error(`Trivy DB fetch refused address literal ${host}`);
  }
  if (!TRIVY_DB_ALLOWED_HOSTS.has(host)) {
    throw new Error(`Trivy DB fetch refused host ${host}`);
  }
  return url;
}

type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

// A dns lookup for https.request that resolves every address and refuses the
// connection if any of them is forbidden; the connection then uses exactly
// the checked addresses (no second resolution to rebind).
export function guardedLookup(resolve: LookupFn = dnsLookup as any) {
  return (
    hostname: string,
    options: any,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      const bad = list.find(({ address }) => isForbiddenAddress(address));
      if (list.length === 0 || bad) {
        const error: NodeJS.ErrnoException = new Error(
          `Trivy DB fetch refused ${hostname}: it resolves to ${
            bad ? `forbidden address ${bad.address}` : "no address"
          }`,
        );
        error.code = "EFORBIDDENADDRESS";
        callback(error, "", 0);
        return;
      }
      if (options?.all) {
        callback(null, list);
      } else {
        callback(null, list[0].address, list[0].family);
      }
    });
  };
}

export type TransportResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
};
export type Transport = (
  url: URL,
  headers: Record<string, string>,
) => Promise<TransportResponse>;

export function httpsTransport({
  resolve,
  timeoutMs = TRIVY_DB_LIMITS.requestTimeoutMs,
}: { resolve?: LookupFn; timeoutMs?: number } = {}): Transport {
  const lookup = guardedLookup(resolve);
  return (url, headers) =>
    new Promise((resolveResponse, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          headers,
          lookup: lookup as any,
          rejectUnauthorized: true,
          timeout: timeoutMs,
        },
        (res) =>
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: res,
          }),
      );
      req.on("timeout", () =>
        req.destroy(new Error(`Trivy DB fetch timed out: ${url.origin}`)),
      );
      req.on("error", reject);
      req.end();
    });
}

// GET with manual redirects: every hop is checked again, credentials are
// only sent to the host they were issued for, and hops are capped.
export async function guardedGet(
  start: string | URL,
  {
    headers = {},
    authHost,
    transport = httpsTransport(),
  }: {
    headers?: Record<string, string>;
    authHost?: string;
    transport?: Transport;
  } = {},
): Promise<TransportResponse & { url: URL }> {
  let url = assertAllowedUrl(start);
  for (let hop = 0; ; hop++) {
    const hopHeaders = { ...headers };
    if (authHost != null && url.hostname !== authHost) {
      delete hopHeaders.Authorization;
    }
    const res = await transport(url, hopHeaders);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.body.resume();
      if (hop >= TRIVY_DB_LIMITS.maxRedirects) {
        throw new Error("Trivy DB fetch: too many redirects");
      }
      url = assertAllowedUrl(new URL(`${res.headers.location}`, url));
      continue;
    }
    return { ...res, url };
  }
}

async function readCapped(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > max) {
      body.destroy();
      throw new Error(`Trivy DB fetch: response exceeds ${max} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerChallenge(header: string | undefined): {
  realm: string;
  params: Record<string, string>;
} | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = Object.create(null);
  for (const [, key, value] of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[key] = value;
  }
  if (!params.realm) return null;
  const { realm, ...rest } = params;
  return { realm, params: rest };
}

// GET a registry URL, answering an anonymous bearer challenge once.
async function registryGet(
  url: URL,
  headers: Record<string, string>,
  transport: Transport,
): Promise<TransportResponse & { url: URL }> {
  const first = await guardedGet(url, { headers, transport });
  if (first.status !== 401) return first;
  first.body.resume();
  const challenge = bearerChallenge(
    `${first.headers["www-authenticate"] ?? ""}`,
  );
  if (!challenge) {
    throw new Error(`Trivy DB fetch: ${url.hostname} refused access (401)`);
  }
  const tokenUrl = assertAllowedUrl(challenge.realm);
  for (const [key, value] of Object.entries(challenge.params)) {
    tokenUrl.searchParams.set(key, value);
  }
  const tokenRes = await guardedGet(tokenUrl, { transport });
  if (tokenRes.status !== 200) {
    tokenRes.body.resume();
    throw new Error(
      `Trivy DB fetch: token request failed (${tokenRes.status})`,
    );
  }
  const tokenBody = JSON.parse(
    (await readCapped(tokenRes.body, TRIVY_DB_LIMITS.maxTokenBytes)).toString(
      "utf8",
    ),
  );
  const token = `${tokenBody?.token ?? tokenBody?.access_token ?? ""}`;
  if (!token) throw new Error("Trivy DB fetch: token response without token");
  return await guardedGet(url, {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    authHost: url.hostname,
    transport,
  });
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type TrivyDbManifest = {
  manifest_digest: string;
  layer_digest: string;
  layer_size: number;
};

// The manifest of trivy-db:2 at a source, verified: its digest (from the
// bytes, and the registry's header if any) and exactly one database layer.
export async function fetchTrivyDbManifest(
  source: TrivyDbSource,
  transport: Transport,
): Promise<TrivyDbManifest & { url: URL }> {
  const url = new URL(
    `https://${source.registry}/v2/${source.repository}/manifests/${TRIVY_DB_TAG}`,
  );
  const res = await registryGet(
    url,
    { Accept: "application/vnd.oci.image.manifest.v1+json" },
    transport,
  );
  if (res.status !== 200) {
    res.body.resume();
    throw new Error(
      `Trivy DB fetch: manifest request to ${source.registry} failed (${res.status})`,
    );
  }
  const raw = await readCapped(res.body, TRIVY_DB_LIMITS.maxManifestBytes);
  const manifest_digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const headerDigest = `${res.headers["docker-content-digest"] ?? ""}`;
  if (headerDigest && headerDigest !== manifest_digest) {
    throw new Error("Trivy DB fetch: manifest digest mismatch");
  }
  const manifest = JSON.parse(raw.toString("utf8"));
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  if (layers.length !== 1) {
    throw new Error("Trivy DB fetch: manifest must have exactly one layer");
  }
  const [layer] = layers;
  if (layer?.mediaType !== TRIVY_DB_LAYER_MEDIA_TYPE) {
    throw new Error("Trivy DB fetch: unexpected layer media type");
  }
  if (!DIGEST.test(`${layer?.digest ?? ""}`)) {
    throw new Error("Trivy DB fetch: invalid layer digest");
  }
  const size = Number(layer?.size);
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > TRIVY_DB_LIMITS.maxCompressedBytes
  ) {
    throw new Error("Trivy DB fetch: layer size out of bounds");
  }
  return {
    url,
    manifest_digest,
    layer_digest: layer.digest,
    layer_size: size,
  };
}

// Writes a stream to a new file (O_EXCL), checking its size and sha256.
async function writeVerifiedBlob({
  body,
  path,
  digest,
  size,
}: {
  body: Readable;
  path: string;
  digest: string;
  size: number;
}): Promise<void> {
  const hash = createHash("sha256");
  let total = 0;
  const handle = await open(path, "wx", 0o600);
  try {
    // One pipeline, so an error anywhere (network, size, disk) rejects here.
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          total += chunk.length;
          if (total > size) {
            done(
              new Error("Trivy DB fetch: blob larger than the manifest says"),
            );
            return;
          }
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      handle.createWriteStream(),
    );
  } finally {
    await handle.close().catch(() => {});
  }
  if (total !== size) {
    throw new Error("Trivy DB fetch: blob size differs from the manifest");
  }
  if (`sha256:${hash.digest("hex")}` !== digest) {
    throw new Error("Trivy DB fetch: blob digest mismatch");
  }
}

// Reads a gzipped tar of the database: exactly trivy.db and metadata.json,
// as plain regular files with plain names, within the size caps.  Anything
// else (links, devices, directories, pax headers, paths, extra or repeated
// entries) is refused.  Each file is written to dir with O_EXCL.
export async function extractTrivyDbArchive(
  archive: Readable,
  dir: string,
): Promise<void> {
  type State =
    | { kind: "header" }
    | {
        kind: "data";
        name: string;
        remaining: number;
        padding: number;
        out: WriteStream;
      }
    | { kind: "padding"; remaining: number }
    | { kind: "end"; zeroBlocks: number };
  const seen = new Set<string>();
  let buffered: Buffer = Buffer.alloc(0);
  let decompressed = 0;
  let state = { kind: "header" } as State;
  // A getter, so TypeScript doesn't narrow state across the async callbacks.
  const current = (): State => state;

  const parseOctal = (field: Buffer): number => {
    const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(text)) {
      throw new Error("Trivy DB archive: invalid numeric field");
    }
    const value = parseInt(text, 8);
    if (!Number.isSafeInteger(value)) {
      throw new Error("Trivy DB archive: numeric field out of range");
    }
    return value;
  };

  const startEntry = async (header: Buffer): Promise<void> => {
    if (header.every((byte) => byte === 0)) {
      state = { kind: "end", zeroBlocks: 1 };
      return;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 32 : header[i];
    }
    if (sum !== parseOctal(header.subarray(148, 156))) {
      throw new Error("Trivy DB archive: header checksum mismatch");
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const type = String.fromCharCode(header[156]);
    const prefix = header
      .subarray(257, 263)
      .toString("ascii")
      .startsWith("ustar")
      ? header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "")
      : "";
    if (type !== "0" && type !== "\0") {
      throw new Error(
        `Trivy DB archive: entry '${name}' is not a regular file (type '${type === "\0" ? "\\0" : type}')`,
      );
    }
    const cap = DB_ENTRIES.get(name);
    if (prefix || cap == null) {
      throw new Error(`Trivy DB archive: unexpected entry '${prefix}${name}'`);
    }
    if (seen.has(name)) {
      throw new Error(`Trivy DB archive: repeated entry '${name}'`);
    }
    seen.add(name);
    const size = parseOctal(header.subarray(124, 136));
    if (size > cap) {
      throw new Error(`Trivy DB archive: '${name}' exceeds ${cap} bytes`);
    }
    const handle = await open(join(dir, name), "wx", 0o644);
    const out = handle.createWriteStream();
    // Write errors reach the caller through each write's callback; this
    // keeps the stream's error event from escaping as unhandled.
    out.on("error", () => {});
    const padding = (512 - (size % 512)) % 512;
    state = { kind: "data", name, remaining: size, padding, out };
    if (size === 0) await finishEntry();
  };

  const finishEntry = async (): Promise<void> => {
    if (state.kind !== "data") return;
    const { out, padding } = state;
    await new Promise<void>((done, fail) => {
      out.once("error", fail);
      out.end(() => done());
    });
    state =
      padding > 0
        ? { kind: "padding", remaining: padding }
        : { kind: "header" };
  };

  const consume = async (): Promise<void> => {
    for (;;) {
      if (state.kind === "header" || state.kind === "end") {
        if (buffered.length < 512) return;
        const block = buffered.subarray(0, 512);
        buffered = buffered.subarray(512);
        if (state.kind === "end") {
          if (!block.every((byte) => byte === 0)) {
            throw new Error("Trivy DB archive: data after the end of archive");
          }
          state = { kind: "end", zeroBlocks: state.zeroBlocks + 1 };
          continue;
        }
        await startEntry(block);
        continue;
      }
      if (buffered.length === 0) return;
      if (state.kind === "padding") {
        const take = Math.min(state.remaining, buffered.length);
        buffered = buffered.subarray(take);
        state =
          state.remaining - take > 0
            ? { kind: "padding", remaining: state.remaining - take }
            : { kind: "header" };
        continue;
      }
      const take = Math.min(state.remaining, buffered.length);
      const piece = buffered.subarray(0, take);
      buffered = buffered.subarray(take);
      state.remaining -= take;
      const { out } = state;
      await new Promise<void>((done, fail) =>
        out.write(piece, (err) => (err ? fail(err) : done())),
      );
      if (state.remaining === 0) await finishEntry();
    }
  };

  const gunzip = createGunzip();
  try {
    await pipeline(
      archive,
      gunzip,
      new Writable({
        async write(chunk: Buffer, _enc, done) {
          try {
            decompressed += chunk.length;
            if (decompressed > TRIVY_DB_LIMITS.maxDecompressedBytes) {
              throw new Error(
                "Trivy DB archive: decompressed size exceeds the limit",
              );
            }
            buffered = buffered.length
              ? Buffer.concat([buffered, chunk])
              : chunk;
            await consume();
            done();
          } catch (err) {
            done(err as Error);
          }
        },
      }),
    );
  } finally {
    const last = current();
    if (last.kind === "data") {
      // A refused archive leaves a partial file (removed with its staging
      // directory); its pending write errors must not escape as unhandled.
      last.out.on("error", () => {});
      last.out.destroy();
    }
  }
  const final = current();
  if (final.kind !== "end" || final.zeroBlocks < 2) {
    throw new Error("Trivy DB archive: truncated (no end-of-archive marker)");
  }
  if (buffered.length > 0) {
    throw new Error("Trivy DB archive: data after the end of archive");
  }
  for (const name of DB_ENTRIES.keys()) {
    if (!seen.has(name)) {
      throw new Error(`Trivy DB archive: missing '${name}'`);
    }
  }
}

// One database preparation at a time per cache directory: the db/, staging
// and retired names are shared by every scanner image using the cache.
const cacheLocks = new Map<string, Promise<unknown>>();

export async function withTrivyCacheLock<T>(
  trivy_cache_dir: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = resolvePath(trivy_cache_dir);
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const settled = run.catch(() => {});
  cacheLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (cacheLocks.get(key) === settled) cacheLocks.delete(key);
  }
}

// Fetches trivy-db:2 into <cache>/db (from the first source that works) and
// returns where it came from.  The cache's previous database is replaced
// only once the new one is complete and verified.
export async function fetchTrivyDb({
  trivy_cache_dir,
  sources = TRIVY_DB_SOURCES,
  transport = httpsTransport(),
  now = () => new Date(),
  renameDir = rename,
}: {
  trivy_cache_dir: string;
  sources?: TrivyDbSource[];
  transport?: Transport;
  now?: () => Date;
  // (tests inject failures here)
  renameDir?: (from: string, to: string) => Promise<void>;
}): Promise<TrivyDbProvenance> {
  await mkdir(trivy_cache_dir, { recursive: true, mode: 0o755 });
  const target = join(trivy_cache_dir, "db");
  await recoverInterruptedSwap(trivy_cache_dir, target);
  // Leftovers of a fetch that was interrupted (a crash or restart) are large;
  // fetches are serialized per cache, so none of these is in use.
  for (const name of await readdir(trivy_cache_dir)) {
    if (name.startsWith(".db-staging-") || name.startsWith(".db-retired-")) {
      await rm(join(trivy_cache_dir, name), { recursive: true, force: true });
    }
  }
  const errors: string[] = [];
  for (const source of sources) {
    const staging = await mkdtemp(join(trivy_cache_dir, ".db-staging-"));
    try {
      const manifest = await fetchTrivyDbManifest(source, transport);
      const blobUrl = new URL(
        `https://${source.registry}/v2/${source.repository}/blobs/${manifest.layer_digest}`,
      );
      const blob = await registryGet(blobUrl, {}, transport);
      if (blob.status !== 200) {
        blob.body.resume();
        throw new Error(`blob request failed (${blob.status})`);
      }
      const archivePath = join(staging, "db.tar.gz");
      await writeVerifiedBlob({
        body: blob.body,
        path: archivePath,
        digest: manifest.layer_digest,
        size: manifest.layer_size,
      });
      const dbDir = join(staging, "db");
      await mkdir(dbDir, { mode: 0o755 });
      await extractTrivyDbArchive(createReadStream(archivePath), dbDir);
      await rm(archivePath, { force: true });

      // Like Trivy after its own download: mark when it was fetched.
      const metadataPath = join(dbDir, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (
        metadata == null ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new Error("invalid metadata.json");
      }
      const fetchedAt = now().toISOString();
      metadata.DownloadedAt = fetchedAt;
      await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o644 });
      const provenance: TrivyDbProvenance = {
        source: `${source.registry}/${source.repository}:${TRIVY_DB_TAG}`,
        manifest_digest: manifest.manifest_digest,
        layer_digest: manifest.layer_digest,
        fetched_at: fetchedAt,
        integrity:
          "blobs verified against the manifest digest; the database is fetched by a mutable tag, so scan results are advisory",
      };
      await writeFile(
        join(dbDir, TRIVY_DB_SOURCE_FILE),
        JSON.stringify(provenance),
        { mode: 0o644, flag: "wx" },
      );

      const retired = join(
        trivy_cache_dir,
        `.db-retired-${randomBytes(6).toString("hex")}`,
      );
      const hadOld = await stat(target).then(
        () => true,
        () => false,
      );
      if (hadOld) await renameDir(target, retired);
      try {
        await renameDir(dbDir, target);
      } catch (err) {
        // The old database goes back where it was.
        if (hadOld) await rename(retired, target);
        throw err;
      }
      if (hadOld) await rm(retired, { recursive: true, force: true });
      return provenance;
    } catch (err) {
      errors.push(`${source.registry}: ${(err as Error)?.message ?? err}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  throw new Error(`Trivy DB fetch failed: ${errors.join("; ")}`);
}

// A swap interrupted between its two renames (a crash) leaves no db/ but a
// retired one: put the newest retired database back.
async function recoverInterruptedSwap(
  trivy_cache_dir: string,
  target: string,
): Promise<void> {
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  )
    return;
  const retired: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of await readdir(trivy_cache_dir)) {
    if (!name.startsWith(".db-retired-")) continue;
    const path = join(trivy_cache_dir, name);
    retired.push({ path, mtimeMs: (await stat(path)).mtimeMs });
  }
  retired.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (retired[0]) await rename(retired[0].path, target);
}

const PROVENANCE_SOURCES = new Set(
  TRIVY_DB_SOURCES.map(
    ({ registry, repository }) => `${registry}/${repository}:${TRIVY_DB_TAG}`,
  ),
);

// The provenance record as written by fetchTrivyDb, or undefined if anything
// about it is off (missing fields, unknown source, malformed digest or time).
export function validTrivyDbProvenance(
  value: unknown,
): TrivyDbProvenance | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { source, manifest_digest, layer_digest, fetched_at, integrity } =
    record;
  if (
    typeof source !== "string" ||
    !PROVENANCE_SOURCES.has(source) ||
    typeof manifest_digest !== "string" ||
    !DIGEST.test(manifest_digest) ||
    typeof layer_digest !== "string" ||
    !DIGEST.test(layer_digest) ||
    typeof fetched_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(fetched_at) ||
    !Number.isFinite(Date.parse(fetched_at)) ||
    typeof integrity !== "string" ||
    !integrity
  ) {
    return undefined;
  }
  return { source, manifest_digest, layer_digest, fetched_at, integrity };
}

// The provenance of the cache's database: undefined when there is none or it
// is invalid (e.g. a database the scanner image seeded itself, before the
// host fetched it).  Such a cache is never used.
export async function readTrivyDbProvenance(
  trivy_cache_dir: string,
): Promise<TrivyDbProvenance | undefined> {
  try {
    return validTrivyDbProvenance(
      JSON.parse(
        await readFile(
          join(trivy_cache_dir, "db", TRIVY_DB_SOURCE_FILE),
          "utf8",
        ),
      ),
    );
  } catch {
    return undefined;
  }
}
