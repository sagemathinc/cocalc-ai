import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readPortableSessionHistory,
  truncateSessionHistory,
  truncateSessionHistoryById,
} from "../codex-session-store";

async function makeSessionFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-session-store-"));
  const filePath = path.join(dir, "rollout-test.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function readLines(filePath: string): Promise<string[]> {
  const text = await readFile(filePath, "utf8");
  return text.trimEnd().split("\n");
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

describe("truncateSessionHistory", () => {
  it("keeps only the most recent compaction checkpoints once stale ones accumulate", async () => {
    const filePath = await makeSessionFile([
      JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }),
      compactedLine("old-1"),
      eventLine("after-old-1"),
      compactedLine("old-2"),
      eventLine("after-old-2"),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);

    await expect(
      truncateSessionHistory(filePath, {
        maxBytes: 1,
        keepCompactions: 2,
      }),
    ).resolves.toBe(true);

    await expect(readLines(filePath)).resolves.toEqual([
      JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);
  });

  it("does not rewrite files that only contain the retained number of compactions", async () => {
    const filePath = await makeSessionFile([
      JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);
    const before = await readFile(filePath, "utf8");

    await expect(
      truncateSessionHistory(filePath, {
        maxBytes: 1,
        keepCompactions: 2,
      }),
    ).resolves.toBe(false);

    await expect(readFile(filePath, "utf8")).resolves.toBe(before);
  });

  it("can export a trimmed portable copy without mutating the source file", async () => {
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

  it("can truncate a session by id from the sessions root", async () => {
    const sessionsRoot = await mkdtemp(
      path.join(os.tmpdir(), "codex-session-root-"),
    );
    const sessionId = "sess-lookup";
    const sessionDir = path.join(sessionsRoot, "2026", "04", "09");
    await mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `rollout-${sessionId}.jsonl`);
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
        compactedLine("old-1"),
        eventLine("after-old-1"),
        compactedLine("keep-1"),
        eventLine("after-keep-1"),
        compactedLine("keep-2"),
        eventLine("after-keep-2"),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(
      truncateSessionHistoryById(sessionId, {
        sessionsRoot,
        force: true,
        keepCompactions: 2,
      }),
    ).resolves.toBe(true);

    await expect(readLines(filePath)).resolves.toEqual([
      JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
      compactedLine("keep-1"),
      eventLine("after-keep-1"),
      compactedLine("keep-2"),
      eventLine("after-keep-2"),
    ]);
  });
});
