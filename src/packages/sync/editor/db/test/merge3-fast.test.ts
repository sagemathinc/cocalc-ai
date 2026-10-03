/*
The document merge (dbMerge3) only merges records changed on both sides; it
must give the same result as merging the whole documents as strings
(mergeDbStrings), which is the reference.
*/

import { from_str } from "../doc";
import { from_str as immerFromStr } from "../../immer-db/doc";
import { dbMerge3, mergeDbStrings } from "../merge3";
import { makeRng, type Rng } from "../../sim";

const opts = { primaryKeys: ["type", "id"], stringCols: ["input"] };

describe.each([
  ["immutable", from_str],
  ["immer", immerFromStr],
])("partial primary keys (%s)", (_, from) => {
  const fromStr = (s: string): any =>
    from(s, opts.primaryKeys, opts.stringCols);
  const merge3 = dbMerge3<any>(fromStr, (d) => d.to_str(), opts);
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  test.each(["id", "type"])(
    "preserves all records when %s is missing, in every insertion order",
    (missingKey) => {
      const partial: any = { type: "settings", id: "extra", value: 0 };
      delete partial[missingKey];
      const extra = { type: "settings", id: "extra", value: 42 };
      const cell = { type: "cell", id: "a", input: "base" };
      // Construct each version directly: patch application can itself use
      // partial selectors and hide the merge regression by losing data first.
      const document = (records: object[], order: number[]) =>
        fromStr(order.map((i) => JSON.stringify(records[i])).join("\n"));
      for (const baseOrder of orders) {
        for (const aOrder of orders) {
          for (const bOrder of orders) {
            const base = document([partial, extra, cell], baseOrder);
            const a = document(
              [partial, extra, { ...cell, input: "edited" }],
              aOrder,
            );
            const b = document([{ ...partial, value: 1 }, extra, cell], bOrder);
            for (const [left, right] of [
              [a, b],
              [b, a],
            ]) {
              const reference = fromStr(
                mergeDbStrings({
                  ...opts,
                  base: base.to_str(),
                  a: left.to_str(),
                  b: right.to_str(),
                }),
              );
              const result = merge3(base, left, right);
              expect(result.is_equal(reference)).toBe(true);
              const records = result
                .to_str()
                .split("\n")
                .map((line: string) => JSON.parse(line));
              expect(records).toHaveLength(3);
              expect(records).toContainEqual(extra);
              expect(records).toContainEqual({ ...partial, value: 1 });
              expect(records).toContainEqual({ ...cell, input: "edited" });
            }
          }
        }
      }
    },
  );
});

const words = ["a", "b", "c", "x = 1", "print(x)", "\n", "tk"];
const pick = <T>(rng: Rng, xs: T[]) => xs[Math.floor(rng() * xs.length)];

function randomRecord(rng: Rng, id: string) {
  const r: any = { type: pick(rng, ["cell", "cell", "settings"]), id };
  if (rng() < 0.9)
    r.input = Array.from({ length: 3 }, () => pick(rng, words)).join(" ");
  if (rng() < 0.5) r.pos = Math.floor(rng() * 10);
  if (rng() < 0.3)
    r.output = {
      0: { text: pick(rng, words) },
      1: rng() < 0.5 ? { data: 1 } : undefined,
    };
  if (r.output?.[1] === undefined) delete r.output?.[1];
  return r;
}

function edit(rng: Rng, doc: any, fromStr: (s: string) => any): any {
  const records = doc
    .to_str()
    .split("\n")
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = rng();
    const rec = records.length ? pick(rng, records) : undefined;
    if (r < 0.5 && rec) {
      const field = pick(rng, ["input", "pos", "output", "exec"]);
      if (field === "input")
        rec.input = (rec.input ?? "") + " " + pick(rng, words);
      else if (field === "pos") rec.pos = Math.floor(rng() * 10);
      else if (field === "output")
        rec.output = {
          ...(rec.output ?? {}),
          [Math.floor(rng() * 3)]: { text: pick(rng, words) },
        };
      else delete rec.input;
    } else if (r < 0.75) {
      records.push(randomRecord(rng, `n${Math.floor(rng() * 4)}`));
    } else if (rec) {
      records.splice(records.indexOf(rec), 1);
    }
  }
  // Keep one record per primary key.
  const seen = new Set<string>();
  const unique = records.filter((x: any) => {
    const k = `${x.type}/${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return fromStr(unique.map((x: any) => JSON.stringify(x)).join("\n"));
}

// Chats use the immer document, whose changes() and getOne() return plain
// objects rather than immutable ones.
test.each([
  ["immutable", from_str],
  ["immer", immerFromStr],
])("the fast merge equals the whole-document merge (%s)", (_, from) => {
  const fromStr = (s: string): any =>
    from(s, opts.primaryKeys, opts.stringCols);
  const merge3 = dbMerge3<any>(fromStr, (d) => d.to_str(), opts);
  const rng = makeRng(7);
  for (let run = 0; run < 3000; run++) {
    const base = fromStr(
      Array.from({ length: 1 + Math.floor(rng() * 6) }, (_, i) =>
        JSON.stringify(randomRecord(rng, `c${i}`)),
      ).join("\n"),
    );
    // Build a and b from base by patches, as the patch graph does, so
    // unchanged records are shared.
    const a = base.apply_patch(base.make_patch(edit(rng, base, fromStr)));
    const b = base.apply_patch(base.make_patch(edit(rng, base, fromStr)));
    const ancestors =
      rng() < 0.2
        ? [base, a.apply_patch(a.make_patch(edit(rng, a, fromStr)))]
        : undefined;
    const fast = merge3(base, a, b, ancestors);
    const reference = fromStr(
      mergeDbStrings({
        ...opts,
        base: base.to_str(),
        a: a.to_str(),
        b: b.to_str(),
        ancestors: ancestors?.map((d) => d.to_str()),
      }),
    );
    if (!fast.is_equal(reference)) {
      throw new Error(
        `run ${run}: ${JSON.stringify({ base: base.to_str(), a: a.to_str(), b: b.to_str(), fast: fast.to_str(), reference: reference.to_str() }, null, 1)}`,
      );
    }
  }
});
