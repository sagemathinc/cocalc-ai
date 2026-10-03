import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import {
  findSessionFile,
  readPortableSessionHistory,
  readSessionMeta,
} from "../codex-session-store";

type ZstdZlib = typeof zlib & {
  zstdCompressSync: (input: string | Uint8Array) => Buffer;
};

async function makeSessionFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-session-store-"));
  const filePath = path.join(dir, "rollout-test.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function compactedLine(label: string): string {
  return JSON.stringify({
    type: "compacted",
    payload: { replacement_history: [{ type: "message", label }] },
  });
}

function eventLine(label: string): string {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", label },
  });
}

describe("portable Codex session history", () => {
  it("rejects corrupt compressed history instead of leaving export pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-session-corrupt-"));
    try {
      const filePath = path.join(dir, "rollout-corrupt.jsonl.zst");
      await writeFile(filePath, "not zstd data");
      await expect(readPortableSessionHistory(filePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exports a trimmed copy without mutating the source file", async () => {
    const filePath = await makeSessionFile([
      JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }),
      compactedLine("old-1"),
      eventLine("after-old-1"),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);
    const before = await readFile(filePath, "utf8");

    const portable = await readPortableSessionHistory(filePath, {
      force: true,
      keepCompactions: 2,
    });
    const exported = new TextDecoder().decode(portable.content).trimEnd();

    expect(portable.trimmed).toBe(true);
    expect(portable.totalCompactions).toBe(3);
    expect(exported.split("\n")).toEqual([
      JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(before);
  });

  it("finds and reads Codex-native zstd-compressed rollouts", async () => {
    const sessionsRoot = await mkdtemp(
      path.join(os.tmpdir(), "codex-session-root-"),
    );
    const sessionId = "sess-compressed";
    const sessionDir = path.join(sessionsRoot, "2026", "08", "30");
    await mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `rollout-${sessionId}.jsonl.zst`);
    const content =
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, model: "gpt-5.4" },
        }),
        compactedLine("old-1"),
        eventLine("after-old-1"),
        compactedLine("keep-1"),
        eventLine("after-keep-1"),
        compactedLine("keep-2"),
        eventLine("after-keep-2"),
      ].join("\n") + "\n";
    const compressed = (zlib as ZstdZlib).zstdCompressSync(content);
    await writeFile(filePath, compressed);

    await expect(findSessionFile(sessionId, sessionsRoot)).resolves.toBe(
      filePath,
    );
    await expect(readSessionMeta(filePath)).resolves.toMatchObject({
      payload: { id: sessionId, model: "gpt-5.4" },
    });

    const portable = await readPortableSessionHistory(filePath, {
      force: true,
      keepCompactions: 2,
    });
    const exported = new TextDecoder().decode(portable.content);
    expect(portable.originalBytes).toBe(Buffer.byteLength(content));
    expect(portable.trimmed).toBe(true);
    expect(exported).toContain('"label":"keep-1"');
    expect(exported).not.toContain('"label":"old-1"');
  });

  it("prefers an active plain rollout over a stale compressed copy", async () => {
    const sessionsRoot = await mkdtemp(
      path.join(os.tmpdir(), "codex-session-root-"),
    );
    const sessionId = "sess-active";
    const compressed = path.join(
      sessionsRoot,
      `rollout-${sessionId}.jsonl.zst`,
    );
    const plain = path.join(sessionsRoot, `rollout-${sessionId}.jsonl`);
    await writeFile(compressed, "compressed-placeholder");
    await writeFile(plain, "plain-placeholder");

    await expect(findSessionFile(sessionId, sessionsRoot)).resolves.toBe(plain);
  });
});
