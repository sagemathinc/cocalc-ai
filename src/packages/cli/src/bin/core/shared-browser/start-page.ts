/**
 * What a new tab's start page shows: the web servers running in the project
 * (one click to open your dev server) and the sites this browser visited
 * recently.  Plus site icons for it and for the tabs, fetched from where the
 * browser runs (the project's network, its localhost).
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
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
): Promise<ProjectServer[]> {
  const ports = listeningPorts();
  for (const port of exclude) ports.delete(port);
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
export function recentSites(historyFile: string | null, limit = 8): RecentSite[] {
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

/** Site icons, fetched from the project's network and kept a while. */
export class Favicons {
  private cache = new Map<
    string,
    { type: string; body: Buffer } | null | Promise<{ type: string; body: Buffer } | null>
  >();

  async get(url: string): Promise<{ type: string; body: Buffer } | null> {
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return null;
    const known = this.cache.get(url);
    if (known !== undefined) return await known;
    const loading = this.fetch(url);
    this.remember(url, loading);
    const icon = await loading;
    this.remember(url, icon);
    return icon;
  }

  private remember(url: string, value: any) {
    this.cache.delete(url);
    this.cache.set(url, value);
    while (this.cache.size > 300)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private async fetch(url: string): Promise<{ type: string; body: Buffer } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok || body.length === 0 || body.length > 256 * 1024) return null;
      if (/^image\//i.test(type)) return { type, body };
      // Plenty of servers send .ico files as octet-stream.
      if (/\.ico(\?|$)/i.test(url)) return { type: "image/x-icon", body };
      return null;
    } catch {
      return null;
    }
  }
}
