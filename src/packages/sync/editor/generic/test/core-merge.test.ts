/*
Merging of concurrent edits in the patch graph for string documents, found by
the collaborative editing fuzzer. See
src/.agents/harden-realtime-collaborative-editing-plan-2026-09-30.md.

Patch graph values used to apply every patch in time order with fuzzy
diff-match-patch application, including concurrent patches: a deletion whose
context changed concurrently could be relocated onto similar text elsewhere,
silently deleting someone else's text. With the string codec's merge3, each
patch applies to the exact value of its parents and concurrent heads merge
three-way from their common ancestor.
*/

import { applyPatch, legacyPatchId, makePatch, PatchGraph } from "patchflow";
import { StringDocument } from "../../string/doc";
import { stringMerge3 } from "../string-merge3";

const codec = {
  fromString: (s: string) => new StringDocument(s),
  toString: (d: any) => d.to_str(),
  applyPatch: (d: any, p: unknown) => d.apply_patch(p),
  applyPatchBatch: (d: any, ps: unknown[]) => d.apply_patch_batch(ps),
  makePatch: (a: any, b: any) => a.make_patch(b),
  merge3: stringMerge3<StringDocument>(
    (s) => new StringDocument(s),
    (d) => d.to_str(),
  ),
};

const base =
  "intro\n\n- - tke1q nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n";
// Client A deletes "tke1q"; concurrently client B un-nests that line.
const aLocal = base.replace("tke1q", "");
const bRemote = base.replace("- - tke1q", "- tke1q");

describe("core merge of concurrent string edits", () => {
  it("does not apply a concurrent deletion to similar text elsewhere", () => {
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const doc = (s: string) => new StringDocument(s);
    const graph = new PatchGraph({ codec });
    graph.add([
      { time: t0, parents: [], patch: doc("").make_patch(doc(base)) },
      { time: t1, parents: [t0], patch: doc(base).make_patch(doc(bRemote)) },
      { time: t2, parents: [t0], patch: doc(base).make_patch(doc(aLocal)) },
    ]);
    expect(graph.value().to_str()).toBe(
      "intro\n\n-  nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n",
    );
  });

  it("raw fuzzy patch application still relocates the deletion", () => {
    // This is why concurrent heads must not be fuzzy-applied to each other.
    const [merged] = applyPatch(makePatch(base, aLocal), bRemote);
    expect(merged).not.toContain("tke10q");
  });
});
