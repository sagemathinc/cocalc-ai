// Read Codex session history for portable CoCalc chat exports. Codex owns all
// mutation and maintenance of its rollout store.

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createJsonLineReader } from "@cocalc/util/json-lines";
import type { Readable, Transform } from "node:stream";
import * as zlib from "node:zlib";

const DEFAULT_KEEP_COMPACTIONS = 2;
// Codex rollout JSONL is not "one line per turn". A single turn can emit many
// lines (token counts, reasoning deltas, tool calls/outputs, messages, etc.),
// while a single `compacted` line can summarize many older turns. That means
// line count is a poor trigger for trimming. In practice, the bad failure mode
// is accumulated old compaction checkpoints making resume slow and memory
// hungry, even when the raw file is still well below 100 MiB. Keep the byte
// threshold modest and also require more compaction checkpoints than we plan to
// retain, so portable exports discard stale summarized history without
// modifying Codex's authoritative rollout.
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
  return (
    files.find((file) => file.endsWith(suffix)) ??
    files.find((file) => file.endsWith(`${suffix}.zst`))
  );
}

function isCompressedSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl.zst");
}

type ZstdZlib = typeof zlib & {
  createZstdDecompress?: () => Transform;
};

function openSessionReadStream(filePath: string): Readable {
  const source = createReadStream(filePath);
  if (!isCompressedSessionFile(filePath)) {
    source.setEncoding("utf8");
    return source;
  }
  const createZstdDecompress = (zlib as ZstdZlib).createZstdDecompress;
  if (createZstdDecompress == null) {
    source.destroy();
    throw new Error(
      "this Node.js runtime cannot read Codex .jsonl.zst session files",
    );
  }
  const output = source.pipe(createZstdDecompress());
  output.setEncoding("utf8");
  output.once("close", () => source.destroy());
  return output;
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
  const stream = openSessionReadStream(filePath);
  const rl = createJsonLineReader(stream);
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
  const compressed = isCompressedSessionFile(filePath);
  if (keepCompactions <= 0 && !compressed) {
    return {
      originalBytes: stats.size,
      totalCompactions: 0,
    };
  }
  if (!force && !compressed && stats.size < maxBytes) {
    return {
      originalBytes: stats.size,
      totalCompactions: 0,
    };
  }

  const compactionLines: number[] = [];
  let firstLine: string | undefined;
  let totalLines = 0;
  let totalCompactions = 0;
  let decodedBytes = 0;
  const input = openSessionReadStream(filePath);
  const rl = createJsonLineReader(input);
  try {
    for await (const line of rl) {
      decodedBytes += Buffer.byteLength(line, "utf8") + 1;
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
  const originalBytes = compressed ? decodedBytes : stats.size;

  if (totalCompactions < minCompactionsToTruncate) {
    return {
      firstLine,
      originalBytes,
      totalCompactions,
    };
  }
  if (compactionLines.length === 0) {
    return {
      firstLine,
      originalBytes,
      totalCompactions,
    };
  }
  const startIndex = compactionLines[0];
  if (startIndex <= 1) {
    return {
      firstLine,
      originalBytes,
      totalCompactions,
    };
  }

  return {
    firstLine,
    originalBytes,
    totalCompactions,
    startIndex,
  };
}

async function renderTrimmedSessionHistory(
  filePath: string,
  plan: SessionHistoryPlan,
): Promise<Uint8Array> {
  if (
    plan.startIndex == null &&
    plan.firstLine == null &&
    !isCompressedSessionFile(filePath)
  ) {
    return new Uint8Array(await fs.readFile(filePath));
  }
  const chunks: string[] = [];
  if (plan.startIndex != null && plan.firstLine != null) {
    chunks.push(`${plan.firstLine}\n`);
  }
  const input = openSessionReadStream(filePath);
  const rl = createJsonLineReader(input);
  let lineNum = 0;
  try {
    for await (const line of rl) {
      if (plan.startIndex == null || lineNum >= plan.startIndex) {
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
