import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, rm, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  readAgentAttachmentSnapshots,
  readAgentFileReferences,
} from "./agent-attachments";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  validateAttachmentPayload,
} from "@cocalc/conat/agents/attachments";

test("binary snapshots bind bytes to digest and keep metadata byte-free", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-attachments-test-"));
  try {
    const path = join(dir, "report.bin"),
      data = Buffer.from([0, 255, 128]);
    await writeFile(path, data);
    const result = await readAgentAttachmentSnapshots([path]);
    validateAttachmentPayload(result.metadata, result.files);
    assert.deepEqual(result.files[0].data, data);
    assert.equal(
      result.files[0].sha256,
      createHash("sha256").update(data).digest("hex"),
    );
    assert.equal("data" in result.metadata.files[0], false);
    assert.deepEqual(await readAgentFileReferences([path]), {
      kind: "project-files",
      files: [{ kind: "project-file", path }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("count and byte bounds reject without loading an oversized file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-attachments-test-"));
  try {
    const path = join(dir, "large");
    await writeFile(path, "");
    await truncate(path, AGENT_ATTACHMENT_MAX_BYTES + 1);
    await assert.rejects(readAgentAttachmentSnapshots([path]), /32 MiB/);
    await assert.rejects(
      readAgentAttachmentSnapshots(Array(17).fill(path)),
      /16 attachment/,
    );
    // A same-project reference transfers no file content and need not cap file size.
    assert.equal((await readAgentFileReferences([path])).kind, "project-files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directories, symlinks and devices are not attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-attachments-test-"));
  try {
    const path = join(dir, "data"),
      link = join(dir, "link");
    await writeFile(path, "contents");
    await symlink(path, link);
    for (const unsupported of [dir, link, "/dev/null"]) {
      await assert.rejects(readAgentAttachmentSnapshots([unsupported]));
      await assert.rejects(readAgentFileReferences([unsupported]));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("growth after stat cannot trigger an unbounded read and always closes the handle", async () => {
  let closed = 0;
  const reads: number[] = [];
  const opener = mock.method(require("node:fs/promises"), "open", async () => ({
    stat: async () => ({ isFile: () => true, size: 3, mtimeMs: 1, ctimeMs: 1 }),
    read: async (buffer: Buffer, _offset: number, length: number) => {
      reads.push(length);
      buffer.fill(1);
      return { bytesRead: length };
    },
    close: async () => {
      closed++;
    },
  }));
  try {
    await assert.rejects(
      readAgentAttachmentSnapshots(["report.bin"]),
      /changed during snapshot/,
    );
    assert.deepEqual(reads, [3, 1]);
    assert.equal(closed, 1);
  } finally {
    opener.mock.restore();
  }
});
