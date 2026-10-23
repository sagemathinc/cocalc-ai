import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveInboxAttachments } from "./agent-inbox-attachments";

function inbox(message_id: string, files: [string, string][], bad = -1) {
  return async (index: number) => {
    const [name, text] = files[index];
    const data = new TextEncoder().encode(text);
    return {
      message_id,
      index,
      count: files.length,
      name,
      size: data.byteLength,
      sha256:
        index === bad
          ? "0".repeat(64)
          : createHash("sha256").update(data).digest("hex"),
      data,
    };
  };
}

test("an inbox message's files are saved and checked", async () => {
  const message_id = randomUUID();
  const dir = join(mkdtempSync(join(tmpdir(), "inbox-")), "out");
  const saved = await saveInboxAttachments({
    message_id,
    dir,
    fetch: inbox(message_id, [
      ["report.md", "# Report\n"],
      ["data.csv", "a,b\n"],
    ]),
  });
  assert.deepEqual(
    saved.files.map((file) => file.name),
    ["report.md", "data.csv"],
  );
  assert.equal(readFileSync(join(dir, "data.csv"), "utf8"), "a,b\n");
});

test("nothing is overwritten, and content must match its SHA-256", async () => {
  const message_id = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "inbox-"));
  writeFileSync(join(dir, "report.md"), "mine");
  await assert.rejects(
    saveInboxAttachments({
      message_id,
      dir,
      fetch: inbox(message_id, [["report.md", "theirs"]]),
    }),
    /exists; choose another --dir/,
  );
  assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "mine");
  await assert.rejects(
    saveInboxAttachments({
      message_id,
      dir: join(dir, "other"),
      fetch: inbox(message_id, [["x.txt", "x"]], 0),
    }),
    /does not match its SHA-256/,
  );
  await assert.rejects(
    saveInboxAttachments({
      message_id,
      dir: join(dir, "third"),
      fetch: inbox(message_id, [["../escape", "x"]]),
    }),
    /refusing attachment name/,
  );
});
