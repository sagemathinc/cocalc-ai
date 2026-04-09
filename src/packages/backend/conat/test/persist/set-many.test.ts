import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataEncoding } from "@cocalc/conat/core/client";
import { pstream } from "@cocalc/backend/conat/persist";

function rawToString(raw?: Buffer | Uint8Array): string | undefined {
  return raw == null ? undefined : Buffer.from(raw).toString();
}

describe("persist setMany batching", () => {
  let dir: string;
  let stream: ReturnType<typeof pstream>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-set-many-"));
    stream = pstream({ path: join(dir, "stream") });
  });

  afterEach(async () => {
    await stream?.close?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a batch in one transaction", () => {
    const exec = jest.spyOn((stream as any).db, "exec");
    const results = stream.setMany(
      Array.from({ length: 5 }, (_, i) => ({
        key: `key-${i}`,
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from(`value-${i}`),
      })),
    );

    expect(results).toHaveLength(5);
    expect(results.every((result) => "seq" in result)).toBe(true);
    expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
    expect(exec.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(stream.keys().sort()).toEqual([
      "key-0",
      "key-1",
      "key-2",
      "key-3",
      "key-4",
    ]);
  });

  it("keeps per-item failures local to the failed item", () => {
    const first = stream.set({
      key: "existing",
      encoding: DataEncoding.JsonCodec,
      raw: Buffer.from("original"),
    });

    const results = stream.setMany([
      {
        key: "existing",
        previousSeq: first.seq + 1,
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from("wrong-seq"),
      },
      {
        key: "new-key",
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from("new"),
      },
    ]);

    expect(results[0]).toMatchObject({ code: "wrong-last-sequence" });
    expect(results[1]).toMatchObject({ seq: expect.any(Number) });
    expect(
      rawToString(stream.get({ key: "existing", seq: undefined })?.raw),
    ).toBe("original");
    expect(
      rawToString(stream.get({ key: "new-key", seq: undefined })?.raw),
    ).toBe("new");
  });
});
