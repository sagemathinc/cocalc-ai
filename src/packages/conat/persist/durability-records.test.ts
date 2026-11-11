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

  it("an unreadable or garbled dirty record fails closed (unverified)", () => {
    const r = testDurabilityRecords();
    r.arm("/e");
    writeFileSync(r.dirtyPath("/e"), "not json");
    expect(r.check("/e")).toBe("unverified");
    if (process.getuid?.() !== 0) {
      chmodSync(r.dirtyPath("/e"), 0);
      expect(r.check("/e")).toBe("unverified");
    }
  });

  it("keys by the logical id, not by what it resolves to", () => {
    const r = testDurabilityRecords();
    expect(r.dirtyPath("/x/y")).not.toBe(r.dirtyPath("/x/./y/../y2"));
    expect(r.dirtyPath("/x/y")).toMatch(/\/dirty\/[0-9a-f]{64}$/);
  });
});
