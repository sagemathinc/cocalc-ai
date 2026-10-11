/**
 * What a new tab's start page shows: the web servers running in the project
 * (one click to open your dev server) and the sites this browser visited
 * recently.  Plus site icons for it and for the tabs, fetched from the
 * project's network (public sites only).
 */
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface ProjectServer {
  port: number;
  url: string;
  // The page's title, else what runs it (e.g. "node vite.js").
  label: string;
}

export interface RecentSite {
  url: string;
  title: string;
}

// Our own infrastructure is not the user's server: CoCalc's programs (not
// merely its node, which users run their own servers with) and browsers.
export function isInfrastructure(cmdline: string): boolean {
  const [program = "", ...args] = cmdline.trim().split(/\s+/);
  return (
    /cocalc-chromium|headless_shell|chrom(e|ium)/i.test(program) ||
    args.some((arg) => /^\/opt\/cocalc\/|cocalc-cli/.test(arg))
  );
}

// Listening TCP ports (any address: all reachable as localhost) and their
// socket inodes.
export function listeningPorts(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Map<number, string[]> {
  const ports = new Map<number, string[]>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue;
      const port = parseInt(cols[1].split(":")[1] ?? "", 16);
      if (!Number.isInteger(port) || port <= 0) continue;
      ports.set(port, [...(ports.get(port) ?? []), cols[9]]);
    }
  }
  return ports;
}

// The command line of the process that owns each socket inode we can see.
function socketOwners(inodes: Set<string>): Map<string, string> {
  const owners = new Map<string, string>();
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return owners;
  }
  for (const pid of pids.slice(0, 5000)) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (!inode || !inodes.has(inode) || owners.has(inode)) continue;
      try {
        owners.set(
          inode,
          readFileSync(`/proc/${pid}/cmdline`, "utf8")
            .replace(/\0+$/, "")
            .replace(/\0/g, " "),
        );
      } catch {}
    }
  }
  return owners;
}

// "node /home/user/app/node_modules/.bin/vite --port 5173" -> "node vite".
export function describeCommand(cmdline: string): string {
  const words = cmdline.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const program = basename(words[0]);
  const script = words.slice(1).find((w) => !w.startsWith("-"));
  return (script ? `${program} ${basename(script)}` : program).slice(0, 40);
}

export function pageTitle(html: string): string {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  return title
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// Web servers only: a port that answers HTTP.
async function probe(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!/html/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      return "";
    }
    const reader = res.body?.getReader();
    let html = "";
    while (reader && html.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      html += Buffer.from(value).toString("utf8");
      if (/<\/title>/i.test(html)) break;
    }
    await reader?.cancel().catch(() => {});
    return pageTitle(html);
  } catch {
    return null;
  }
}

export async function projectServers(
  exclude: Set<number>,
  limit = 12,
  // Only these ports (tests: probing every port reaches other tests' servers).
  only?: Set<number>,
): Promise<ProjectServer[]> {
  const ports = listeningPorts();
  for (const port of exclude) ports.delete(port);
  if (only)
    for (const port of ports.keys()) if (!only.has(port)) ports.delete(port);
  const owners = socketOwners(new Set([...ports.values()].flat()));
  const candidates = [...ports.entries()]
    .map(([port, inodes]) => ({
      port,
      cmdline: inodes.map((i) => owners.get(i)).find(Boolean) ?? "",
    }))
    .filter(({ cmdline }) => !isInfrastructure(cmdline))
    .sort((a, b) => a.port - b.port)
    .slice(0, 40);
  const probed = await Promise.all(
    candidates.map(async (c) => ({ ...c, title: await probe(c.port) })),
  );
  // Pages with a title first: those are the apps people open.  A server we
  // can say nothing about (no title, no visible process) is left out.
  return probed
    .filter((c) => c.title != null && (c.title || c.cmdline))
    .sort((a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1) || a.port - b.port)
    .slice(0, limit)
    .map(({ port, cmdline, title }) => ({
      port,
      url: `http://localhost:${port}/`,
      label: title || describeCommand(cmdline),
    }));
}

// The most recently visited sites (one entry per host), from the profile's
// history, read from a copy since Chromium holds the database open.
export function recentSites(
  historyFile: string | null,
  limit = 8,
): RecentSite[] {
  if (!historyFile) return [];
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "cocalc-history-"));
    const copy = join(dir, "History");
    copyFileSync(historyFile, copy);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(copy, { readOnly: true });
    let rows: { url: string; title: string }[] = [];
    try {
      rows = db
        .prepare(
          "SELECT url, title FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 300",
        )
        .all();
    } finally {
      db.close();
    }
    const seen = new Set<string>();
    const sites: RecentSite[] = [];
    for (const { url, title } of rows) {
      let host: string;
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) continue;
        // The servers in the project are listed on their own.
        if (/^(localhost|127\.|\[::1\])/.test(u.hostname)) continue;
        host = u.hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (seen.has(host)) continue;
      seen.add(host);
      sites.push({ url, title: `${title ?? ""}`.trim().slice(0, 60) || host });
      if (sites.length >= limit) break;
    }
    return sites;
  } catch {
    return [];
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Site icons for the viewer (tabs, the start page), fetched from the
 * project's network and kept a while.  Only from public addresses: a
 * collaborator watching the browser must not be able to make the project
 * fetch the host's or the cloud's internal services (the metadata server, a
 * private network, the project's own servers) by asking for an "icon".
 */
export class Favicons {
  private cache = new Map<string, Icon | null | Promise<Icon | null>>();

  constructor(
    private readonly options: {
      // Tests: where a host name points, and which addresses are allowed.
      lookup?: (host: string) => Promise<string[]>;
      allowAddress?: (address: string) => boolean;
    } = {},
  ) {}

  async get(url: string): Promise<Icon | null> {
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return null;
    const known = this.cache.get(url);
    if (known !== undefined) return await known;
    const loading = this.fetch(url).catch(() => null);
    this.remember(url, loading);
    const icon = await loading;
    this.remember(url, icon);
    return icon;
  }

  private remember(url: string, value: Icon | null | Promise<Icon | null>) {
    this.cache.delete(url);
    this.cache.set(url, value);
    while (this.cache.size > 300)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private async fetch(first: string): Promise<Icon | null> {
    const deadline = Date.now() + ICON_TIMEOUT_MS;
    let url = new URL(first);
    for (let hops = 0; hops <= ICON_MAX_REDIRECTS; hops++) {
      if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        return null;
      const address = await this.vet(url.hostname);
      if (!address) return null;
      const res = await getPinned(url, address, deadline);
      if (res.redirect) {
        url = new URL(res.redirect, url);
        continue;
      }
      if (res.status !== 200 || !res.body) return null;
      const type = sniffImage(res.body);
      return type ? { type, body: res.body } : null;
    }
    return null;
  }

  // The address to connect to, if every address of the host is public (so
  // the check is the connection: no second lookup to rebind).
  private async vet(hostname: string): Promise<string | null> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const allowed = this.options.allowAddress ?? isPublicAddress;
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else if (this.options.lookup) addresses = await this.options.lookup(host);
    else
      addresses = (await lookup(host, { all: true, verbatim: true })).map(
        (entry) => entry.address,
      );
    if (addresses.length === 0 || !addresses.every(allowed)) return null;
    return addresses[0];
  }
}

export interface Icon {
  type: string;
  body: Buffer;
}

const ICON_TIMEOUT_MS = 5000;
const ICON_MAX_REDIRECTS = 3;
const ICON_MAX_BYTES = 100 * 1024;

// One GET to that address (with the URL's host name for TLS and the Host
// header), without following redirects, reading at most ICON_MAX_BYTES.
function getPinned(
  url: URL,
  address: string,
  deadline: number,
): Promise<{ status: number; redirect?: string; body?: Buffer }> {
  const family = isIP(address);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "image/*", "user-agent": "Mozilla/5.0" },
        lookup: (_host: string, options: any, done: any) =>
          options?.all
            ? done(null, [{ address, family }])
            : done(null, address, family),
        timeout: Math.max(1, deadline - Date.now()),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, redirect: `${res.headers.location}` });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ICON_MAX_BYTES) {
            req.destroy();
            resolve({ status: 0 });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** The image type of these bytes, judged by its content, or null. */
export function sniffImage(body: Buffer): string | null {
  if (body.length < 4) return null;
  const head = body.subarray(0, 16);
  if (head[0] === 0x89 && head.subarray(1, 4).toString() === "PNG")
    return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  if (head.subarray(0, 4).toString() === "GIF8") return "image/gif";
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0)
    return "image/x-icon";
  if (
    head.subarray(0, 4).toString() === "RIFF" &&
    head.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (head[0] === 0x42 && head[1] === 0x4d) return "image/bmp";
  // SVG is text; shown as an image (an <img>), its scripts never run.
  const text = body.subarray(0, 512).toString("utf8").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text))
    return "image/svg+xml";
  return null;
}

// Addresses that are not the public internet.
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::1", 128],
  // IPv4 in IPv6: refused (IPv4-compatible, NAT64, 6to4, Teredo), except
  // IPv4-mapped addresses, which BlockList checks against the IPv4 rules.
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC.check(address, "ipv4");
  if (family === 6) return !NOT_PUBLIC.check(address, "ipv6");
  return false;
}
