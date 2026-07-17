import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import { openPaths } from "@cocalc/conat/persist/storage";

describe("persistent stream close lifecycle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-close-reopen-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fully closes a database before the same path can reopen", async () => {
    const path = join(dir, "stream");
    const first = pstream({ path });
    first.set({
      key: "first",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("one"),
    });

    first.close();
    const second = pstream({ path });
    second.set({
      key: "second",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("two"),
    });

    // The old async close deleted this marker after the replacement stream
    // opened, proving both connections overlapped on the same SQLite path.
    await Promise.resolve();
    expect(openPaths.has(path)).toBe(true);
    expect(second.get({ key: "first", seq: undefined })).toBeDefined();
    expect(second.get({ key: "second", seq: undefined })).toBeDefined();

    second.close();
    expect(openPaths.has(path)).toBe(false);
  });
});
