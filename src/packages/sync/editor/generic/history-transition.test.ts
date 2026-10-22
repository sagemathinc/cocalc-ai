import { from_str as dbFromStr } from "../db/doc";
import { StringDocument } from "../string/doc";
import {
  canDropAll,
  recoveryCopyName,
  valueBytesCapped,
} from "./history-transition";

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

describe("valueBytesCapped: the size of to_str(), measured without building it", () => {
  it("a string document", () => {
    const doc = new StringDocument("hello ü €");
    expect(valueBytesCapped(doc, 1000)).toBe(utf8(doc.to_str()));
    expect(valueBytesCapped(doc, 5)).toBeUndefined();
  });

  it("a db document is exactly its JSON lines, with escaping", () => {
    const doc = dbFromStr(
      [
        JSON.stringify({ id: 1, s: 'a "quoted" \\ line\nü €\u0001' }),
        JSON.stringify({ id: 2, 'key "q" ü': [1, null, true, { x: 2.5 }] }),
      ].join("\n"),
      ["id"],
    );
    const value = doc.to_str();
    expect(valueBytesCapped(doc, 10_000)).toBe(utf8(value));
    expect(valueBytesCapped(doc, utf8(value))).toBe(utf8(value));
    expect(valueBytesCapped(doc, utf8(value) - 1)).toBeUndefined();
  });

  it("lone surrogates count as JSON writes them (\\udxxx)", () => {
    const doc = dbFromStr(
      [
        JSON.stringify({ id: 1, s: "lone \ud800 high" }),
        JSON.stringify({ id: 2, s: "lone \udfff low", "\udbff": "key" }),
        JSON.stringify({ id: 3, s: "pair 😀" }),
      ].join("\n"),
      ["id"],
    );
    expect(valueBytesCapped(doc, 10_000)).toBe(utf8(doc.to_str()));
  });

  it("no document: nothing to save", () => {
    expect(valueBytesCapped(undefined, 10)).toBe(0);
  });
});

describe("recoveryCopyName", () => {
  const now = new Date(Date.UTC(2026, 9, 21, 7, 5, 9));

  it("is beside the file, with the time, the client and random characters", () => {
    expect(
      recoveryCopyName("a/b.txt", {
        clientId: "c-1/2",
        now,
        random: "abcd1234",
      }),
    ).toBe("a/b.txt.unsaved-20261021-070509-c12abcd1234");
  });

  it("differs between tabs and between attempts", () => {
    const names = new Set<string>();
    for (const clientId of ["one", "two"]) {
      for (let i = 0; i < 100; i++) {
        names.add(recoveryCopyName("x.txt", { clientId, now }));
      }
    }
    expect(names.size).toBe(200);
  });
});

describe("canDropAll: reload only if everything is proven in the new history", () => {
  const included = { status: "included" as const };

  it("nothing pending and nothing unsaved", () => {
    expect(canDropAll({ ids: [], hasDraft: false, hasLaterEdits: false })).toBe(
      true,
    );
  });

  it("every pending patch included", () => {
    expect(
      canDropAll({
        ids: ["a", "b"],
        statuses: { a: included, b: included },
        hasDraft: false,
        hasLaterEdits: false,
      }),
    ).toBe(true);
  });

  it.each(["live", "excluded", "absent", "unknown"] as const)(
    "a patch that is %s",
    (status) => {
      expect(
        canDropAll({
          ids: ["a", "b"],
          statuses: { a: included, b: { status } },
          hasDraft: false,
          hasLaterEdits: false,
        }),
      ).toBe(false);
    },
  );

  it("no answer, or an answer missing an id", () => {
    const opts = { ids: ["a"], hasDraft: false, hasLaterEdits: false };
    expect(canDropAll(opts)).toBe(false);
    expect(canDropAll({ ...opts, statuses: {} })).toBe(false);
  });

  it("a draft, or edits since the transition began", () => {
    expect(canDropAll({ ids: [], hasDraft: true, hasLaterEdits: false })).toBe(
      false,
    );
    expect(canDropAll({ ids: [], hasDraft: false, hasLaterEdits: true })).toBe(
      false,
    );
  });
});
