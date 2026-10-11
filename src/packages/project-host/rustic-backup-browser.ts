/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import { rustic as rusticPath } from "@cocalc/backend/sandbox/install";

import {
  attachBackupBrowserProcessToCgroup,
  removeBackupBrowserProcessCgroup,
} from "./host-service-cgroup";
import { trimTrailingSlashes } from "@cocalc/util/linear-text";

const logger = getLogger("project-host:rustic-backup-browser");

const DAV_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_DAV_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 50_000;
const MAX_SEARCH_RESULTS = 10_000;
const MAX_SEARCH_PREVIEW_RESULTS = 100;
const MAX_SEARCH_PREVIEW_TIME_MS = 5_000;
const MAX_SEARCH_PREVIEW_CONCURRENCY = 8;
const MAX_SEARCH_PREVIEW_DIRECTORIES = 10_000;
const MAX_SEARCH_PREVIEW_ENTRIES = 100_000;
const MAX_SEARCH_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_TIME_MS = 45 * 1000;
const MAX_HELPER_AGE_MS = 30 * 60 * 1000;
const HELPER_IDLE_MS = 15 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
const SNAPSHOT_PATH_TEMPLATE = "{hostname}/{time}--{long_id}";
const SNAPSHOT_TIME_TEMPLATE = "%Y%m%dT%H%M%S%z";

export interface BackupBrowserEntry {
  name: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

export interface BackupBrowserSnapshot {
  id: string;
  time: Date;
  summary: { [key: string]: string | number };
}

export interface BackupBrowserSearchResult extends BackupBrowserEntry {
  id: string;
  time: Date;
  path: string;
}

export type BackupBrowserSearchTruncationReason = "results" | "time" | "limits";

export interface BackupBrowserSearchResponse {
  results: BackupBrowserSearchResult[];
  truncated: boolean;
  truncationReason?: BackupBrowserSearchTruncationReason;
}

interface DavEntry {
  pathname: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

interface SnapshotLocation extends BackupBrowserSnapshot {
  segment: string;
}

interface RepositoryDescriptor {
  key: string;
  profileHash: string;
  profilePath: string;
}

interface BrowserInstance {
  child: ChildProcess;
  client: RusticWebDavClient;
  descriptor: RepositoryDescriptor;
  startedAt: number;
  lastUsed: number;
  stale: boolean;
  stopping: boolean;
  log: () => string;
}

interface ManagerOptions {
  start?: (
    descriptor: RepositoryDescriptor,
  ) => Promise<Omit<BrowserInstance, "lastUsed" | "stale" | "stopping">>;
  now?: () => number;
  idleSweep?: boolean;
  find?: typeof runRusticFind;
}

export class BackupBrowserHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BackupBrowserHttpError";
  }
}

export class BackupBrowserLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupBrowserLimitError";
  }
}

class BackupBrowserSearchComplete extends Error {
  constructor(public readonly reason: BackupBrowserSearchTruncationReason) {
    super(`backup search preview stopped after reaching the ${reason} limit`);
    this.name = "BackupBrowserSearchComplete";
  }
}

export class BackupSnapshotNotFoundError extends Error {
  constructor(id: string) {
    super(`backup ${id} is not available in the Rustic repository browser`);
    this.name = "BackupSnapshotNotFoundError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTomlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function repositoryIdentityFromProfile(profile: string): string {
  let section = "";
  const values: [string, string][] = [];
  for (const line of profile.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const key = `${section}.${assignment[1]}`;
    if (/(?:password|secret|access_key|token|credential)/i.test(key)) {
      continue;
    }
    values.push([key, parseTomlScalar(assignment[2])]);
  }
  values.sort(([a], [b]) => a.localeCompare(b));
  if (!values.length) {
    throw new Error("Rustic repository profile has no non-secret identity");
  }
  return JSON.stringify(values);
}

async function repositoryDescriptor(
  profilePath: string,
): Promise<RepositoryDescriptor> {
  const profile = await readFile(profilePath, "utf8");
  return {
    key: sha256(repositoryIdentityFromProfile(profile)),
    profileHash: sha256(profile),
    profilePath,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    );
}

function xmlElement(block: string, name: string): string | undefined {
  return block.match(
    new RegExp(
      `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`,
      "i",
    ),
  )?.[1];
}

function decodeDavPath(href: string): string {
  const pathname = new URL(decodeXml(href), "http://127.0.0.1").pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new Error(`invalid percent-encoding in WebDAV path: ${pathname}`);
  }
}

export function parseDavEntries(xml: string): DavEntry[] {
  const blocks = xml.match(
    /<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi,
  );
  if (!blocks) return [];
  return blocks.map((block) => {
    const href = xmlElement(block, "href");
    if (href == null) {
      throw new Error("WebDAV response is missing href");
    }
    const lastModified = xmlElement(block, "getlastmodified");
    const parsedMtime = lastModified
      ? Date.parse(decodeXml(lastModified).trim())
      : 0;
    const contentLength = Number(
      decodeXml(xmlElement(block, "getcontentlength") ?? "0").trim(),
    );
    return {
      pathname: decodeDavPath(href),
      isDir: /<(?:[A-Za-z0-9_-]+:)?collection(?:\s[^>]*)?\s*\/?\s*>/i.test(
        block,
      ),
      mtime: Number.isFinite(parsedMtime) ? parsedMtime : 0,
      size: Number.isFinite(contentLength) ? contentLength : 0,
    };
  });
}

function normalizeBackupPath(rawPath?: string): string {
  const normalized = trimTrailingSlashes(
    `${rawPath ?? ""}`.replace(/\\/g, "/").replace(/^\/+/, ""),
  );
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    throw new Error("invalid backup path");
  }
  return segments.join("/");
}

function encodePath(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}${segments.length ? "/" : ""}`;
}

function trimDirectoryPath(pathname: string): string {
  return pathname === "/" ? "/" : trimTrailingSlashes(pathname);
}

function childEntries(
  entries: DavEntry[],
  pathname: string,
): BackupBrowserEntry[] {
  const base = pathname === "/" ? "/" : `${trimDirectoryPath(pathname)}/`;
  const parent = trimDirectoryPath(pathname);
  const result: BackupBrowserEntry[] = [];
  for (const entry of entries) {
    const entryPath = trimDirectoryPath(entry.pathname);
    if (entryPath === parent || !entryPath.startsWith(base)) continue;
    const relative = entryPath.slice(base.length);
    if (!relative || relative.includes("/")) continue;
    result.push({
      name: relative,
      isDir: entry.isDir,
      mtime: entry.mtime,
      size: entry.size,
    });
  }
  if (result.length > MAX_DIRECTORY_ENTRIES) {
    throw new BackupBrowserLimitError(
      `backup directory has more than ${MAX_DIRECTORY_ENTRIES.toLocaleString()} entries; narrow the path before browsing`,
    );
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function parseSnapshotSegment(segment: string): SnapshotLocation | undefined {
  const match =
    segment.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-])(\d{2})(\d{2})--SnapshotId\(([0-9a-f]{64})\)$/i,
    ) ??
    segment.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-])(\d{2})(\d{2})--([0-9a-f]{64})$/i,
    );
  if (!match) return;
  const [, year, month, day, hour, minute, second, sign, tzHour, tzMinute, id] =
    match;
  const time = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${tzHour}:${tzMinute}`,
  );
  if (!Number.isFinite(time.valueOf())) return;
  return { id, time, summary: {}, segment };
}

async function readResponseBody(
  response: Response,
  maxBytes = MAX_DAV_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BackupBrowserLimitError(
          `Rustic metadata response exceeded ${Math.floor(maxBytes / 1024 / 1024)} MiB`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export class RusticWebDavClient {
  private readonly snapshots = new Map<string, SnapshotLocation[]>();

  constructor(
    private readonly baseUrl: string,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  private async propfind(
    segments: string[],
    { depth = 1, timeoutMs = this.requestTimeoutMs } = {},
  ): Promise<{ entries: DavEntry[]; pathname: string }> {
    const requestPathname = encodePath(segments);
    const pathname = `/${segments.join("/")}${segments.length ? "/" : ""}`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${requestPathname}`, {
        method: "PROPFIND",
        headers: { Depth: `${depth}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BackupBrowserHttpError(
        `unable to reach Rustic repository browser: ${err}`,
      );
    }
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new BackupBrowserHttpError(
        `Rustic repository browser returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
        response.status,
      );
    }
    return { entries: parseDavEntries(body), pathname };
  }

  async probe(timeoutMs = 2_000): Promise<void> {
    await this.propfind([], { depth: 0, timeoutMs });
  }

  private async hostExists(host: string): Promise<boolean> {
    const { entries, pathname } = await this.propfind([]);
    return childEntries(entries, pathname).some(
      (entry) => entry.isDir && entry.name === host,
    );
  }

  async listBackups(projectId: string): Promise<SnapshotLocation[]> {
    const cached = this.snapshots.get(projectId);
    if (cached) return cached;
    const host = `project-${projectId}`;
    let response: Awaited<ReturnType<RusticWebDavClient["propfind"]>>;
    try {
      response = await this.propfind([host]);
    } catch (err) {
      if (
        err instanceof BackupBrowserHttpError &&
        (err.status === 404 || err.status === 500) &&
        !(await this.hostExists(host))
      ) {
        this.snapshots.set(projectId, []);
        return [];
      }
      throw err;
    }
    const snapshots = childEntries(response.entries, response.pathname)
      .filter((entry) => entry.isDir && entry.name !== "latest")
      .map((entry) => parseSnapshotSegment(entry.name))
      .filter((entry): entry is SnapshotLocation => entry != null);
    snapshots.sort((a, b) => a.time.valueOf() - b.time.valueOf());
    this.snapshots.set(projectId, snapshots);
    return snapshots;
  }

  private async snapshotLocation(
    projectId: string,
    id: string,
  ): Promise<SnapshotLocation> {
    const snapshot = (await this.listBackups(projectId)).find(
      (entry) => entry.id === id,
    );
    if (!snapshot) throw new BackupSnapshotNotFoundError(id);
    return snapshot;
  }

  async listDirectory({
    projectId,
    id,
    path,
    timeoutMs,
  }: {
    projectId: string;
    id: string;
    path?: string;
    timeoutMs?: number;
  }): Promise<BackupBrowserEntry[]> {
    const snapshot = await this.snapshotLocation(projectId, id);
    const relative = normalizeBackupPath(path);
    const segments = [
      `project-${projectId}`,
      snapshot.segment,
      ...relative.split("/").filter(Boolean),
    ];
    const response = await this.propfind(segments, { timeoutMs });
    return childEntries(response.entries, response.pathname);
  }

  async getEntry({
    projectId,
    id,
    path,
  }: {
    projectId: string;
    id: string;
    path: string;
  }): Promise<BackupBrowserEntry | undefined> {
    const relative = normalizeBackupPath(path);
    if (!relative) return;
    const parent = relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : "";
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    return (await this.listDirectory({ projectId, id, path: parent })).find(
      (entry) => entry.name === name,
    );
  }
}

function captureProcessLog(child: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk}`.slice(-16_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output.trim();
}

function profileArgument(profilePath: string): string {
  return profilePath.endsWith(".toml")
    ? profilePath.slice(0, -".toml".length)
    : profilePath;
}

function normalizeGlob(pattern: string): string {
  return `${pattern ?? ""}`
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "");
}

function globMatcher(pattern: string, caseSensitive: boolean): RegExp {
  const input = normalizeGlob(pattern);
  let source = "^";
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const end = input.indexOf("]", i + 1);
      if (end < 0) {
        source += "\\[";
      } else {
        let content = input.slice(i + 1, end);
        if (content.startsWith("!")) content = `^${content.slice(1)}`;
        source += `[${content.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, caseSensitive ? "" : "i");
}

interface BackupSearchDirectoryTask {
  snapshot: SnapshotLocation;
  path: string;
}

function isMissingBackupDirectory(err: unknown): boolean {
  return err instanceof BackupBrowserHttpError && err.status === 404;
}

async function findDirectoryPreview({
  client,
  projectId,
  snapshots,
  glob,
  iglob,
  path,
  recursive,
  now = Date.now,
}: {
  client: RusticWebDavClient;
  projectId: string;
  snapshots: SnapshotLocation[];
  glob?: string[];
  iglob?: string[];
  path?: string;
  recursive?: boolean;
  now?: () => number;
}): Promise<BackupBrowserSearchResponse> {
  if (!snapshots.length || (!glob?.length && !iglob?.length)) {
    return { results: [], truncated: false };
  }
  const matchers = [
    ...(glob ?? []).map((pattern) => globMatcher(pattern, true)),
    ...(iglob ?? []).map((pattern) => globMatcher(pattern, false)),
  ];
  const scope = normalizeBackupPath(path);
  const deadline = now() + MAX_SEARCH_PREVIEW_TIME_MS;
  const results: BackupBrowserSearchResult[] = [];
  let directories = 0;
  let entriesSeen = 0;
  let level: BackupSearchDirectoryTask[] = snapshots.map((snapshot) => ({
    snapshot,
    path: scope,
  }));

  const truncated = (
    truncationReason: BackupBrowserSearchTruncationReason,
  ): BackupBrowserSearchResponse => ({
    results,
    truncated: true,
    truncationReason,
  });

  while (level.length) {
    const nextLevel: BackupSearchDirectoryTask[] = [];
    for (
      let offset = 0;
      offset < level.length;
      offset += MAX_SEARCH_PREVIEW_CONCURRENCY
    ) {
      if (now() >= deadline) return truncated("time");
      const batch = level.slice(
        offset,
        offset + MAX_SEARCH_PREVIEW_CONCURRENCY,
      );
      if (directories + batch.length > MAX_SEARCH_PREVIEW_DIRECTORIES) {
        return truncated("limits");
      }
      directories += batch.length;
      const remaining = Math.max(1, deadline - now());
      const responses = await Promise.all(
        batch.map(async (task) => {
          try {
            return {
              task,
              entries: await client.listDirectory({
                projectId,
                id: task.snapshot.id,
                path: task.path,
                timeoutMs: remaining,
              }),
            };
          } catch (err) {
            if (isMissingBackupDirectory(err)) {
              return { task, entries: [] as BackupBrowserEntry[] };
            }
            if (now() >= deadline) {
              return {
                task,
                entries: [] as BackupBrowserEntry[],
                timedOut: true,
              };
            }
            throw err;
          }
        }),
      );
      let timedOut = false;
      for (const response of responses) {
        timedOut ||= response.timedOut === true;
        for (const entry of response.entries) {
          if (++entriesSeen > MAX_SEARCH_PREVIEW_ENTRIES) {
            return truncated("limits");
          }
          const entryPath = response.task.path
            ? `${response.task.path}/${entry.name}`
            : entry.name;
          if (
            recursive &&
            entry.isDir &&
            nextLevel.length < MAX_SEARCH_PREVIEW_DIRECTORIES
          ) {
            nextLevel.push({
              snapshot: response.task.snapshot,
              path: entryPath,
            });
          }
          if (!matchers.some((matcher) => matcher.test(entryPath))) continue;
          if (results.length >= MAX_SEARCH_PREVIEW_RESULTS) {
            return truncated("results");
          }
          results.push({
            ...entry,
            id: response.task.snapshot.id,
            time: response.task.snapshot.time,
            path: entryPath,
          });
        }
      }
      if (timedOut || now() >= deadline) return truncated("time");
    }
    if (!recursive) break;
    if (nextLevel.length >= MAX_SEARCH_PREVIEW_DIRECTORIES) {
      return truncated("limits");
    }
    level = nextLevel;
  }
  return { results, truncated: false };
}

function hasGlobMeta(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parseRusticFindEntry(line: string):
  | (BackupBrowserEntry & {
      path: string;
    })
  | null {
  const match = line.match(
    /^(\S{10})\s+\S+\s+\S+\s+(\d+)\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})\s+("(?:\\.|[^"\\])*")(?:\s+->.*)?\s*$/,
  );
  if (!match) return null;
  const [, mode, rawSize, rawDay, monthName, rawYear, rawHour, rawMinute] =
    match;
  const month = MONTHS[monthName];
  if (month == null) return null;
  let path: string;
  try {
    path = normalizeBackupPath(JSON.parse(match[8]));
  } catch {
    return null;
  }
  if (!path) return null;
  const mtime = Date.UTC(
    Number(rawYear),
    month,
    Number(rawDay),
    Number(rawHour),
    Number(rawMinute),
  );
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    isDir: mode.startsWith("d"),
    mtime,
    size: Number(rawSize),
  };
}

export class RusticFindOutputParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly snapshotById: Map<string, BackupBrowserSnapshot>;
  private readonly scope: string;
  private readonly seen = new Set<string>();
  private buffer = "";
  private group: BackupBrowserSnapshot[] = [];
  private groupHasEntries = false;
  readonly results: BackupBrowserSearchResult[] = [];

  constructor(
    snapshots: BackupBrowserSnapshot[],
    scope?: string,
    private readonly maxResults = MAX_SEARCH_RESULTS,
  ) {
    this.snapshotById = new Map(
      snapshots.map((snapshot) => [snapshot.id, snapshot]),
    );
    this.scope = normalizeBackupPath(scope);
  }

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.consumeLines();
  }

  finish(): BackupBrowserSearchResult[] {
    this.buffer += this.decoder.end();
    this.consumeLines(true);
    return this.results;
  }

  private consumeLines(final = false): void {
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line);
    }
    if (final && this.buffer) {
      this.consumeLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
  }

  private snapshotForPrefix(prefix: string): BackupBrowserSnapshot {
    const matches = [...this.snapshotById.values()].filter(({ id }) =>
      id.startsWith(prefix),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Rustic search returned ambiguous snapshot prefix ${prefix}`,
      );
    }
    return matches[0];
  }

  private consumeLine(line: string): void {
    const header = line.match(/^found in ([0-9a-f]{8,64}) from /);
    if (header) {
      if (this.groupHasEntries) this.group = [];
      this.groupHasEntries = false;
      this.group.push(this.snapshotForPrefix(header[1]));
      return;
    }
    const entry = parseRusticFindEntry(line);
    if (!entry) {
      if (/^[bcdlps-][rwxStTs-]{9}\s/.test(line)) {
        throw new Error(`unable to parse Rustic search result: ${line}`);
      }
      return;
    }
    if (!this.group.length) {
      throw new Error("Rustic search returned a file without a snapshot");
    }
    this.groupHasEntries = true;
    if (
      this.scope &&
      entry.path !== this.scope &&
      !entry.path.startsWith(`${this.scope}/`)
    ) {
      return;
    }
    for (const snapshot of this.group) {
      const key = `${snapshot.id}\0${entry.path}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.results.length >= this.maxResults) {
        throw new BackupBrowserSearchComplete("results");
      }
      this.results.push({
        ...entry,
        id: snapshot.id,
        time: snapshot.time,
      });
    }
  }
}

function rusticFindArgs({
  profilePath,
  snapshots,
  glob,
  iglob,
}: {
  profilePath: string;
  snapshots: BackupBrowserSnapshot[];
  glob?: string[];
  iglob?: string[];
}): string[] {
  const exactPatterns = (glob ?? []).map(normalizeGlob).filter(Boolean);
  const insensitivePatterns = (iglob ?? []).map(normalizeGlob).filter(Boolean);
  const args = [
    "--no-progress",
    "--show-time-offset",
    "-P",
    profileArgument(profilePath),
    "find",
    "--all",
  ];
  if (
    exactPatterns.length === 1 &&
    !insensitivePatterns.length &&
    !hasGlobMeta(exactPatterns[0])
  ) {
    args.push(`--path=${exactPatterns[0]}`);
  } else {
    for (const pattern of exactPatterns) args.push(`--glob=${pattern}`);
    for (const pattern of insensitivePatterns) args.push(`--iglob=${pattern}`);
  }
  args.push(...snapshots.map(({ id }) => id));
  return args;
}

async function runRusticFind({
  profilePath,
  snapshots,
  glob,
  iglob,
  path,
}: {
  profilePath: string;
  snapshots: BackupBrowserSnapshot[];
  glob?: string[];
  iglob?: string[];
  path?: string;
}): Promise<BackupBrowserSearchResponse> {
  if (!snapshots.length || (!glob?.length && !iglob?.length)) {
    return { results: [], truncated: false };
  }
  const parser = new RusticFindOutputParser(snapshots, path);
  const args = rusticFindArgs({ profilePath, snapshots, glob, iglob });
  const supervisor = [
    "read -r _ <&3 || exit 125",
    'parent_pid="$1"',
    "shift",
    '"$@" &',
    'rustic_pid="$!"',
    "trap 'kill -TERM \"$rustic_pid\" 2>/dev/null || true' TERM INT EXIT",
    'while kill -0 "$rustic_pid" 2>/dev/null; do',
    '  if ! kill -0 "$parent_pid" 2>/dev/null; then',
    '    kill -TERM "$rustic_pid" 2>/dev/null || true',
    "    break",
    "  fi",
    "  sleep 2",
    "done",
    'wait "$rustic_pid"',
  ].join("\n");
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      supervisor,
      "cocalc-rustic-find",
      `${process.pid}`,
      rusticPath,
      ...args,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: process.env,
    },
  );
  const gate = child.stdio[3];
  if (!child.pid || !gate || typeof (gate as any).write !== "function") {
    child.kill("SIGKILL");
    throw new Error("unable to create gated Rustic backup search");
  }
  if (!attachBackupBrowserProcessToCgroup({ pid: child.pid })) {
    child.kill("SIGKILL");
    throw new Error(
      "unable to isolate Rustic backup search; reconcile the project host bootstrap",
    );
  }
  child.once("close", () => {
    removeBackupBrowserProcessCgroup({ pid: child.pid! });
  });
  (gate as NodeJS.WritableStream).write("start\n");
  (gate as NodeJS.WritableStream).end();

  return await new Promise<BackupBrowserSearchResponse>((resolve, reject) => {
    let outputBytes = 0;
    let stderr = "";
    let fatal: Error | undefined;
    let completedEarly: BackupBrowserSearchTruncationReason | undefined;
    const stop = (err: Error) => {
      if (fatal) return;
      fatal = err;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    const completeEarly = (reason: BackupBrowserSearchTruncationReason) => {
      if (fatal || completedEarly) return;
      completedEarly = reason;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    const timer = setTimeout(
      () =>
        stop(
          new BackupBrowserLimitError(
            `backup search exceeded ${MAX_SEARCH_TIME_MS / 1000} seconds; narrow the pattern or search path`,
          ),
        ),
      MAX_SEARCH_TIME_MS,
    );
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (fatal || completedEarly) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_SEARCH_OUTPUT_BYTES) {
        stop(
          new BackupBrowserLimitError(
            `backup search output exceeded ${MAX_SEARCH_OUTPUT_BYTES / 1024 / 1024} MiB; narrow the pattern`,
          ),
        );
        return;
      }
      try {
        parser.push(chunk);
      } catch (err) {
        if (err instanceof BackupBrowserSearchComplete) {
          completeEarly(err.reason);
        } else {
          stop(err instanceof Error ? err : new Error(`${err}`));
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", (err) => stop(err));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (fatal) {
        reject(fatal);
        return;
      }
      if (completedEarly) {
        resolve({
          results: parser.results,
          truncated: true,
          truncationReason: completedEarly,
        });
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Rustic backup search exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      try {
        resolve({ results: parser.finish(), truncated: false });
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function startBrowserProcess(
  descriptor: RepositoryDescriptor,
): Promise<Omit<BrowserInstance, "lastUsed" | "stale" | "stopping">> {
  const port = await getPort();
  logger.info("starting Rustic repository browser", {
    repository: descriptor.key.slice(0, 12),
    port,
  });
  const args = [
    "--no-progress",
    "-P",
    profileArgument(descriptor.profilePath),
    "webdav",
    "--address",
    `${DAV_HOST}:${port}`,
    "--file-access",
    "forbidden",
    "--path-template",
    SNAPSHOT_PATH_TEMPLATE,
    "--time-template",
    SNAPSHOT_TIME_TEMPLATE,
  ];
  const supervisor = [
    "read -r _ <&3 || exit 125",
    'parent_pid="$1"',
    "shift",
    '"$@" &',
    'rustic_pid="$!"',
    "trap 'kill -TERM \"$rustic_pid\" 2>/dev/null || true' TERM INT EXIT",
    'while kill -0 "$rustic_pid" 2>/dev/null; do',
    '  if ! kill -0 "$parent_pid" 2>/dev/null; then',
    '    kill -TERM "$rustic_pid" 2>/dev/null || true',
    "    break",
    "  fi",
    "  sleep 2",
    "done",
    'wait "$rustic_pid"',
  ].join("\n");
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      supervisor,
      "cocalc-rustic-browser",
      `${process.pid}`,
      rusticPath,
      ...args,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: process.env,
    },
  );
  const log = captureProcessLog(child);
  const gate = child.stdio[3];
  if (!child.pid || !gate || typeof (gate as any).write !== "function") {
    child.kill("SIGKILL");
    throw new Error("unable to create gated Rustic repository browser");
  }
  if (!attachBackupBrowserProcessToCgroup({ pid: child.pid })) {
    child.kill("SIGKILL");
    throw new Error(
      "unable to isolate Rustic repository browser; reconcile the project host bootstrap",
    );
  }
  child.once("close", (code, signal) => {
    removeBackupBrowserProcessCgroup({ pid: child.pid! });
    logger.info("Rustic repository browser stopped", {
      repository: descriptor.key.slice(0, 12),
      pid: child.pid,
      code,
      signal,
    });
  });
  (gate as NodeJS.WritableStream).write("start\n");
  (gate as NodeJS.WritableStream).end();

  const client = new RusticWebDavClient(`http://${DAV_HOST}:${port}`);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `Rustic repository browser exited during startup${log() ? `: ${log()}` : ""}`,
      );
    }
    try {
      await client.probe();
      logger.info("Rustic repository browser ready", {
        repository: descriptor.key.slice(0, 12),
        pid: child.pid,
        port,
      });
      return {
        child,
        client,
        descriptor,
        startedAt: Date.now(),
        log,
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  killTimer.unref();
  throw new Error(
    `Rustic repository browser did not become ready within ${START_TIMEOUT_MS / 1000} seconds${log() ? `: ${log()}` : ""}`,
  );
}

export class RusticBackupBrowserManager {
  private readonly instances = new Map<string, BrowserInstance>();
  private readonly starts = new Map<string, Promise<BrowserInstance>>();
  private startTail: Promise<unknown> = Promise.resolve();
  private nativeSearchTail: Promise<unknown> = Promise.resolve();
  private previewSearchTail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly start: NonNullable<ManagerOptions["start"]>;
  private readonly findNative: NonNullable<ManagerOptions["find"]>;
  private readonly idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: ManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.start = options.start ?? startBrowserProcess;
    this.findNative = options.find ?? runRusticFind;
    if (options.idleSweep !== false) {
      this.idleTimer = setInterval(() => this.stopIdle(), IDLE_SWEEP_MS);
      this.idleTimer.unref();
    }
  }

  private stop(instance: BrowserInstance): void {
    if (instance.stopping) return;
    instance.stopping = true;
    instance.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (
        instance.child.exitCode == null &&
        instance.child.signalCode == null
      ) {
        instance.child.kill("SIGKILL");
      }
    }, 5_000);
    timer.unref();
  }

  private stopIdle(): void {
    const cutoff = this.now() - HELPER_IDLE_MS;
    for (const [key, instance] of this.instances) {
      if (instance.lastUsed > cutoff) continue;
      this.instances.delete(key);
      this.stop(instance);
    }
  }

  private async startSerialized(
    descriptor: RepositoryDescriptor,
  ): Promise<BrowserInstance> {
    let release!: () => void;
    const previous = this.startTail;
    this.startTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      const started = await this.start(descriptor);
      const instance = {
        ...started,
        lastUsed: this.now(),
        stale: false,
        stopping: false,
      };
      if (this.closed) {
        this.stop(instance);
        throw new Error("Rustic repository browser is closed");
      }
      return instance;
    } finally {
      release();
    }
  }

  private async nativeSearchSerialized<T>(run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.nativeSearchTail;
    this.nativeSearchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async previewSearchSerialized<T>(run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.previewSearchTail;
    this.previewSearchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async get(profilePath: string): Promise<BrowserInstance> {
    if (this.closed) throw new Error("Rustic repository browser is closed");
    const descriptor = await repositoryDescriptor(profilePath);
    const current = this.instances.get(descriptor.key);
    if (
      current &&
      !current.stale &&
      current.descriptor.profileHash === descriptor.profileHash &&
      this.now() - current.startedAt < MAX_HELPER_AGE_MS &&
      current.child.exitCode == null
    ) {
      current.lastUsed = this.now();
      return current;
    }
    const existingStart = this.starts.get(descriptor.key);
    if (existingStart) return await existingStart;
    const task = this.startSerialized(descriptor);
    this.starts.set(descriptor.key, task);
    try {
      const instance = await task;
      const old = this.instances.get(descriptor.key);
      this.instances.set(descriptor.key, instance);
      if (old) this.stop(old);
      return instance;
    } finally {
      this.starts.delete(descriptor.key);
    }
  }

  async markStale(profilePath: string): Promise<void> {
    const descriptor = await repositoryDescriptor(profilePath);
    const instance = this.instances.get(descriptor.key);
    if (instance) instance.stale = true;
  }

  async listBackups({
    profilePath,
    projectId,
  }: {
    profilePath: string;
    projectId: string;
  }): Promise<BackupBrowserSnapshot[]> {
    const instance = await this.get(profilePath);
    instance.lastUsed = this.now();
    return (await instance.client.listBackups(projectId)).map(
      ({ segment: _segment, ...snapshot }) => snapshot,
    );
  }

  async listDirectory({
    profilePath,
    projectId,
    id,
    path,
  }: {
    profilePath: string;
    projectId: string;
    id: string;
    path?: string;
  }): Promise<BackupBrowserEntry[]> {
    const instance = await this.get(profilePath);
    instance.lastUsed = this.now();
    return await instance.client.listDirectory({ projectId, id, path });
  }

  async getEntry({
    profilePath,
    projectId,
    id,
    path,
  }: {
    profilePath: string;
    projectId: string;
    id: string;
    path: string;
  }): Promise<BackupBrowserEntry | undefined> {
    const instance = await this.get(profilePath);
    instance.lastUsed = this.now();
    return await instance.client.getEntry({ projectId, id, path });
  }

  async find({
    profilePath,
    projectId,
    glob,
    iglob,
    path,
    ids,
    preview,
    recursive,
  }: {
    profilePath: string;
    projectId: string;
    glob?: string[];
    iglob?: string[];
    path?: string;
    ids?: string[];
    preview?: boolean;
    recursive?: boolean;
  }): Promise<BackupBrowserSearchResponse> {
    const instance = await this.get(profilePath);
    instance.lastUsed = this.now();
    const allowedIds = ids?.length ? new Set(ids) : undefined;
    const snapshots = (await instance.client.listBackups(projectId)).filter(
      ({ id }) => !allowedIds || allowedIds.has(id),
    );
    if (preview) {
      snapshots.sort((a, b) => b.time.getTime() - a.time.getTime());
      return await this.previewSearchSerialized(
        async () =>
          await findDirectoryPreview({
            client: instance.client,
            projectId,
            snapshots,
            glob,
            iglob,
            path,
            recursive,
            now: this.now,
          }),
      );
    }
    return await this.nativeSearchSerialized(
      async () =>
        await this.findNative({
          profilePath,
          snapshots,
          glob,
          iglob,
          path,
        }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const instance of this.instances.values()) this.stop(instance);
    this.instances.clear();
  }
}

export const rusticBackupBrowser = new RusticBackupBrowserManager();

export const __test__ = {
  childEntries,
  hasGlobMeta,
  findDirectoryPreview,
  globMatcher,
  normalizeBackupPath,
  parseRusticFindEntry,
  parseSnapshotSegment,
  rusticFindArgs,
  MAX_DAV_RESPONSE_BYTES,
  MAX_DIRECTORY_ENTRIES,
  SNAPSHOT_PATH_TEMPLATE,
  SNAPSHOT_TIME_TEMPLATE,
};
