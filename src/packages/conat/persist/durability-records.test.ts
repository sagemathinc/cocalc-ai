import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { testDurabilityRecords } from "./test-durability";

describe("durability records (finding 028)", () => {
  it("arm, disarm: a dirty record exists only in between", () => {
    const r = testDurabilityRecords();
    expect(r.check("/a")).toBe("ok");
    r.arm("/a");
    expect(existsSync(r.dirtyPath("/a"))).toBe(true);
    expect(JSON.parse(readFileSync(r.dirtyPath("/a"), "utf8")).generation).toBe(
      r.generation,
    );
    // our own record: no sync error was seen, so it opens
    expect(r.check("/a")).toBe("ok");
    r.disarm("/a");
    expect(existsSync(r.dirtyPath("/a"))).toBe(false);
    r.disarm("/a"); // absent: fine
  });

  it("a dirty record of another process generation is unverified", () => {
    const crashed = testDurabilityRecords();
    const now = testDurabilityRecords({ root: crashed.root });
    crashed.arm("/b");
    expect(now.check("/b")).toBe("unverified");
  });

  it("poison renames the dirty record into the poisoned-file record, which every generation refuses", () => {
    const r = testDurabilityRecords();
    r.arm("/c");
    r.poison("/c", { where: "test", errcode: 1034 });
    expect(existsSync(r.dirtyPath("/c"))).toBe(false);
    const record = JSON.parse(readFileSync(r.poisonedPath("/c"), "utf8"));
    expect(record).toMatchObject({ kind: "poisoned-file", errcode: 1034 });
    expect(r.check("/c")).toBe("poisoned");
    expect(testDurabilityRecords({ root: r.root }).check("/c")).toBe(
      "poisoned",
    );
  });

  it("poison without a dirty record still writes the poisoned-file record", () => {
    const r = testDurabilityRecords();
    r.poison("/d", { where: "test" });
    expect(r.check("/d")).toBe("poisoned");
  });

  it("a dirty-record directory that can't be read fails closed (unverified)", () => {
    const r = testDurabilityRecords();
    r.arm("/e");
    const dir = require("node:path").dirname(r.dirtyPath("/e"));
    if (process.getuid?.() !== 0) {
      chmodSync(dir, 0);
      try {
        expect(testDurabilityRecords({ root: r.root }).check("/e")).toBe(
          "unverified",
        );
      } finally {
        chmodSync(dir, 0o700);
      }
    }
  });

  it("keys by the logical id, not by what it resolves to", () => {
    const r = testDurabilityRecords();
    expect(r.dirtyPath("/x/y")).not.toBe(r.dirtyPath("/x/./y/../y2"));
    expect(r.dirtyPath("/x/y")).toMatch(
      new RegExp(`/dirty/[0-9a-f]{64}/${r.generation}$`),
    );
  });

  it("each process has its own record: one's disarm never removes another's (#139 B1-3)", () => {
    const a = testDurabilityRecords();
    const b = testDurabilityRecords({ root: a.root });
    a.arm("/f");
    b.arm("/f");
    b.disarm("/f");
    expect(existsSync(a.dirtyPath("/f"))).toBe(true);
    // a live record of another process: this one can't vouch for the cache
    expect(b.check("/f")).toBe("unverified");
    a.disarm("/f");
    expect(b.check("/f")).toBe("ok");
  });

  it("ignores a record still being written (its operation had not started)", () => {
    const a = testDurabilityRecords();
    const b = testDurabilityRecords({ root: a.root });
    a.arm("/g");
    a.disarm("/g");
    require("node:fs").mkdirSync(require("node:path").dirname(a.dirtyPath("/g")), {
      recursive: true,
    });
    writeFileSync(`${a.dirtyPath("/g")}.x.tmp`, "{}");
    expect(b.check("/g")).toBe("ok");
  });
});
