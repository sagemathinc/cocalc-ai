import { PersistentStream } from "./storage";
import { initContext, syncFiles } from "./context";
import { DatabaseSync } from "node:sqlite";
import { statSync, copyFileSync } from "node:fs";

test("compare-and-set creates only absent keys and rejects stale writers", () => {
  initContext({
    sqlite: { DatabaseSync },
    compress: (data) => data,
    decompress: (data) => data,
    syncFiles,
    statSync,
    copyFileSync,
    ensureContainingDirectoryExists: async () => undefined,
  });
  const stream = new PersistentStream({
    path: "/tmp/review-cas-test",
    ephemeral: true,
  });
  try {
    const write = (previousSeq: number) =>
      stream.set({
        key: "review",
        encoding: "json",
        raw: Buffer.from("{}"),
        previousSeq,
      });
    const first = write(0);
    expect(first.seq).toBeGreaterThan(0);
    expect(() => write(0)).toThrow("wrong last sequence");
    const second = write(first.seq);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(() => write(first.seq)).toThrow("wrong last sequence");
  } finally {
    stream.close();
  }
});
