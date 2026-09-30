/*
Three-way merge for text documents, used by the patch graph as its codec's
merge3: each patch applies to the exact value of its own parents and
concurrent heads merge from their common ancestor (see patchflow's
DocCodec.merge3 and mergeStrings3), instead of fuzzy-applying concurrent
patches to each other's text.
*/

import { mergeStrings3 } from "patchflow";

export function stringMerge3<D>(
  fromStr: (text: string) => D,
  toStr: (doc: D) => string,
): (base: D, a: D, b: D, ancestors?: D[]) => D {
  return (base, a, b, ancestors) =>
    fromStr(
      mergeStrings3({
        base: toStr(base),
        a: toStr(a),
        b: toStr(b),
        ancestors: ancestors?.map(toStr),
      }),
    );
}
