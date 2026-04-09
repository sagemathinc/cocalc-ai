// Manage Codex session JSONL files on disk.
// We do this directly because the CLI does not expose a way to update
// session_meta for resumed sessions (e.g. cwd/sandbox), and Codex
// cannot override those settings once a session exists. If upstream
// adds a supported API, we can delete this and call that instead.

import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("ai:acp:codex-session-store");
const DEFAULT_KEEP_COMPACTIONS = 2;
// Codex rollout JSONL is not "one line per turn". A single turn can emit many
// lines (token counts, reasoning deltas, tool calls/outputs, messages, etc.),
// while a single `compacted` line can summarize many older turns. That means
// line count is a poor trigger for trimming. In practice, the bad failure mode
// is accumulated old compaction checkpoints making resume slow and memory
// hungry, even when the raw file is still well below 100 MiB. Keep the byte
// threshold modest and also require more compaction checkpoints than we plan to
// retain, so we only trim when there is actual stale summarized history to
// discard.
const DEFAULT_TRUNCATE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MIN_COMPACTIONS_TO_TRUNCATE = DEFAULT_KEEP_COMPACTIONS + 1;

type SessionMetaLine = {
  type: "session_meta";
  payload: Record<string, unknown>;
};

type SessionHistoryOptions = {
  maxBytes?: number;
  keepCompactions?: number;
  minCompactionsToTruncate?: number;
  force?: boolean;
};

type SessionHistoryPlan = {
  firstLine?: string;
  originalBytes: number;
  totalCompactions: number;
  startIndex?: number;
};

export type PortableSessionHistory = {
  content: Uint8Array;
  trimmed: boolean;
  originalBytes: number;
  exportedBytes: number;
  totalCompactions: number;
};

function defaultCodexHome(): string | undefined {
  if (process.env.COCALC_CODEX_HOME) return process.env.COCALC_CODEX_HOME;
  if (process.env.COCALC_ORIGINAL_HOME) {
    return path.join(process.env.COCALC_ORIGINAL_HOME, ".codex");
  }
  if (process.env.HOME) return path.join(process.env.HOME, ".codex");
  return undefined;
}

export function getSessionsRoot(): string | undefined {
  const home = defaultCodexHome();
  return home ? path.join(home, "sessions") : undefined;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    // Fresh installs/new hosts often don't have any local codex session tree yet.
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return [];
    }
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function findSessionFile(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | undefined> {
  const files = await walk(sessionsRoot);
  const suffix = `-${sessionId}.jsonl`;
  return files.find((file) => file.endsWith(suffix));
}

export async function readSessionMeta(
  filePath: string,
): Promise<SessionMetaLine> {
  const firstLine = await readFirstLine(filePath);
  const parsed = JSON.parse(firstLine) as SessionMetaLine;
  if (!parsed || parsed.type !== "session_meta") {
    throw new Error(`invalid session meta in ${filePath}`);
  }
  return parsed;
}

async function readFirstLine(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return await new Promise<string>((resolve, reject) => {
    let done = false;
    rl.on("line", (line) => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      resolve(line);
    });
    rl.on("close", () => {
      if (!done) {
        reject(new Error(`empty session file ${filePath}`));
      }
    });
    rl.on("error", (err) => reject(err));
    stream.on("error", (err) => reject(err));
  });
}

export async function rewriteSessionMeta(
  filePath: string,
  updater: (payload: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  const firstLine = await readFirstLine(filePath);
  const parsed = JSON.parse(firstLine) as SessionMetaLine;
  if (!parsed || parsed.type !== "session_meta") {
    throw new Error(`invalid session meta in ${filePath}`);
  }
  const nextPayload = updater(parsed.payload);
  if (JSON.stringify(nextPayload) === JSON.stringify(parsed.payload)) {
    return false;
  }
  const nextLine = JSON.stringify({
    type: "session_meta",
    payload: nextPayload,
    timestamp: parsed["timestamp"] ?? new Date().toISOString(),
  });
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}`);
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const output = createWriteStream(tmp, { encoding: "utf8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let wroteFirst = false;
    rl.on("line", (line) => {
      if (!wroteFirst) {
        output.write(`${nextLine}\n`);
        wroteFirst = true;
        return;
      }
      output.write(`${line}\n`);
    });
    rl.on("close", () => {
      output.end();
    });
    rl.on("error", (err) => {
      input.destroy();
      output.destroy();
      reject(err);
    });
    input.on("error", (err) => {
      output.destroy();
      reject(err);
    });
    output.on("error", (err) => {
      input.destroy();
      reject(err);
    });
    output.on("close", () => resolve());
  });
  await fs.rename(tmp, filePath);
  return true;
}

async function planSessionHistoryRewrite(
  filePath: string,
  opts?: SessionHistoryOptions,
): Promise<SessionHistoryPlan> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_TRUNCATE_BYTES;
  const keepCompactions = opts?.keepCompactions ?? DEFAULT_KEEP_COMPACTIONS;
  const minCompactionsToTruncate =
    opts?.minCompactionsToTruncate ?? DEFAULT_MIN_COMPACTIONS_TO_TRUNCATE;
  const force = opts?.force === true;
  const stats = await fs.stat(filePath);
  if (keepCompactions <= 0) {
    return {
      originalBytes: stats.size,
      totalCompactions: 0,
    };
  }
  if (!force && stats.size < maxBytes) {
    return {
      originalBytes: stats.size,
      totalCompactions: 0,
    };
  }

  const compactionLines: number[] = [];
  let firstLine: string | undefined;
  let totalLines = 0;
  let totalCompactions = 0;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (firstLine == null) {
        firstLine = line;
      }
      if (line.includes('"type":"compacted"')) {
        totalCompactions += 1;
        compactionLines.push(totalLines);
        if (compactionLines.length > keepCompactions) {
          compactionLines.shift();
        }
      }
      totalLines += 1;
    }
  } finally {
    rl.close();
    input.destroy();
  }

  if (totalCompactions < minCompactionsToTruncate) {
    return {
      firstLine,
      originalBytes: stats.size,
      totalCompactions,
    };
  }
  if (compactionLines.length === 0) {
    return {
      firstLine,
      originalBytes: stats.size,
      totalCompactions,
    };
  }
  const startIndex = compactionLines[0];
  if (startIndex <= 1) {
    return {
      firstLine,
      originalBytes: stats.size,
      totalCompactions,
    };
  }

  return {
    firstLine,
    originalBytes: stats.size,
    totalCompactions,
    startIndex,
  };
}

async function renderTrimmedSessionHistory(
  filePath: string,
  plan: SessionHistoryPlan,
): Promise<Uint8Array> {
  if (plan.startIndex == null || plan.firstLine == null) {
    return new Uint8Array(await fs.readFile(filePath));
  }
  const chunks: string[] = [`${plan.firstLine}\n`];
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNum = 0;
  try {
    for await (const line of rl) {
      if (lineNum >= plan.startIndex) {
        chunks.push(`${line}\n`);
      }
      lineNum += 1;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return new Uint8Array(Buffer.from(chunks.join(""), "utf8"));
}

export async function readPortableSessionHistory(
  filePath: string,
  opts?: SessionHistoryOptions,
): Promise<PortableSessionHistory> {
  const plan = await planSessionHistoryRewrite(filePath, opts);
  const content = await renderTrimmedSessionHistory(filePath, plan);
  return {
    content,
    trimmed: plan.startIndex != null,
    originalBytes: plan.originalBytes,
    exportedBytes: content.byteLength,
    totalCompactions: plan.totalCompactions,
  };
}

export async function truncateSessionHistoryById(
  sessionId: string,
  opts?: SessionHistoryOptions & {
    sessionsRoot?: string;
  },
): Promise<boolean> {
  const trimmedSessionId = `${sessionId ?? ""}`.trim();
  if (!trimmedSessionId) return false;
  const sessionsRoot = opts?.sessionsRoot ?? getSessionsRoot();
  if (!sessionsRoot) return false;
  const filePath = await findSessionFile(trimmedSessionId, sessionsRoot);
  if (!filePath) return false;
  return await truncateSessionHistory(filePath, opts);
}

// Codex can accumulate huge JSONL session files (multi-GB) because it never
// trims prior compactions. We don't need that full history for CoCalc since the
// authoritative chat log lives in our frontend; we only need recent compaction
// state for context. This keeps session files bounded and prevents OOM/slow
// behavior when resuming old sessions, e.g., "codex resume" will easily use
// 5GB+ loading a massive jsonl history, just to ignore most of it.
// If codex will change to not store all these old pointless compaction
// in the jsonl history and then we can remove this.
export async function truncateSessionHistory(
  filePath: string,
  opts?: SessionHistoryOptions,
): Promise<boolean> {
  const plan = await planSessionHistoryRewrite(filePath, opts);
  if (plan.startIndex == null || plan.firstLine == null) return false;
  const startIndex = plan.startIndex;
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}`);

  await new Promise<void>((resolve, reject) => {
    const read = createReadStream(filePath, { encoding: "utf8" });
    const write = createWriteStream(tmp, { encoding: "utf8" });
    const rlCopy = readline.createInterface({
      input: read,
      crlfDelay: Infinity,
    });
    let lineNum = 0;
    let wroteHeader = false;

    rlCopy.on("line", (line) => {
      if (!wroteHeader) {
        write.write(`${plan.firstLine}\n`);
        wroteHeader = true;
      }
      if (lineNum >= startIndex) {
        write.write(`${line}\n`);
      }
      lineNum += 1;
    });
    rlCopy.on("close", () => {
      write.end();
    });
    rlCopy.on("error", (err) => {
      read.destroy();
      write.destroy();
      reject(err);
    });
    read.on("error", (err) => {
      write.destroy();
      reject(err);
    });
    write.on("error", (err) => {
      read.destroy();
      reject(err);
    });
    write.on("close", () => resolve());
  });

  await fs.rename(tmp, filePath);
  logger.debug("truncated session history", {
    filePath,
    startIndex: plan.startIndex,
    totalCompactions: plan.totalCompactions,
    size: plan.originalBytes,
  });
  return true;
}
