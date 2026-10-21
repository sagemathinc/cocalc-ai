/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
How a stored patch record becomes a patchflow patch, and the codec a
document's patch graph uses: SyncDoc's own, shared so that anything else
reconstructing a document from its stored records (the board recovery
child, project-host/board/recovery-child.ts) does exactly what SyncDoc does.
*/

import { Map, fromJS } from "immutable";
import {
  PatchGraph,
  type DocCodec,
  type PatchEnvelope,
  type PatchId,
  decodePatchId,
  legacyPatchId,
} from "patchflow";
import { stringMerge3 } from "./string-merge3";
import { dbMerge3 } from "../db/merge3";
import type { DocType, Document, Patch } from "./types";

/*- x - patch object
  - patch: if given will be used as an actual patch
      instead of x.patch, which is a JSON string.
*/
export function patchFromRecord({
  x,
  patch,
  size: size0,
}: {
  x: Map<string, any>;
  patch?: any;
  size?: number;
}): Patch {
  const normalizePatchId = (raw: unknown): PatchId => {
    if (typeof raw === "string") {
      // Backward compat: some old patches used ISO timestamps for `time`.
      if (!raw.includes("_")) {
        const legacy = new Date(raw).valueOf();
        if (!Number.isNaN(legacy)) {
          return legacyPatchId(legacy);
        }
      }
      return raw;
    }
    if (typeof raw === "number") {
      return legacyPatchId(raw);
    }
    throw new Error(`invalid patch time: raw='${raw}'`);
  };

  const time = normalizePatchId(x.get("time"));
  const wall: number = x.get("wall") ?? decodePatchId(time).timeMs;
  const user_id: number = x.get("user_id");
  let parents: PatchId[] = (x.get("parents")?.toJS() ?? []).map(
    normalizePatchId,
  );
  let size: number;
  const is_snapshot = x.get("is_snapshot");
  if (is_snapshot) {
    size = x.get("snapshot")?.length ?? 0;
  } else {
    if (patch == null) {
      /* Do **NOT** use misc.from_json, since we definitely
       do not want to unpack ISO timestamps as Date,
       since patch just contains the raw patches from
       user editing.  This was done for a while, which
       led to horrific bugs in some edge cases...
       See https://github.com/sagemathinc/cocalc/issues/1771
    */
      if (x.has("patch")) {
        const p: string = x.get("patch");
        patch = JSON.parse(p);
        size = p.length;
      } else {
        patch = [];
        size = 2;
      }
    } else {
      const p = x.get("patch");
      size = p?.length ?? size0 ?? JSON.stringify(patch).length;
    }
  }

  const obj: Patch = {
    time,
    wall,
    user_id,
    patch,
    size,
    is_snapshot,
    parents,
    version: x.get("version"),
    file: x.get("file"),
  };
  if (x.has("meta")) {
    const m = x.get("meta");
    obj.meta = Map.isMap(m) ? m.toJS() : m;
  }
  const hash = x.get("hash");
  if (typeof hash === "string") {
    obj.hash = hash;
  }
  const mergeParent = x.get("merge_parent");
  const mergePatch = x.get("merge_patch");
  if (mergeParent != null && typeof mergePatch === "string") {
    // A JSON string, like patch (see above).
    obj.merge_parent = normalizePatchId(mergeParent);
    obj.merge_patch = JSON.parse(mergePatch);
  }
  if (x.get("inexact") === true) {
    obj.inexact = true;
  }
  if (is_snapshot) {
    obj.snapshot = x.get("snapshot"); // this is a string
    obj.seq_info = x.get("seq_info")?.toJS();
    if (obj.snapshot == null || obj.seq_info == null) {
      console.warn("WARNING: message = ", x.toJS());
      throw Error(
        `message with is_snapshot true must also set snapshot and seq_info fields -- time=${time}`,
      );
    }
  }
  return obj;
}

export function toPatchflowEnvelope(p: Patch): PatchEnvelope {
  return {
    time: p.time,
    wall: p.wall,
    patch: p.patch,
    parents: p.parents,
    userId: p.user_id,
    size: p.size,
    version: p.version,
    isSnapshot: p.is_snapshot,
    snapshot: p.snapshot,
    seqInfo: p.seq_info,
    file: p.file,
    meta: p.meta,
    hash: p.hash,
    mergeParent: p.merge_parent,
    mergePatch: p.merge_patch,
    ...(p.inexact ? { inexact: true } : {}),
  };
}

export function patchflowCodec({
  fromStr,
  doctype,
}: {
  fromStr: (text: string) => Document;
  doctype: DocType;
}): DocCodec {
  return {
    fromString: (text: string) => fromStr(text),
    toString: (doc: Document) =>
      (doc as any).to_str ? (doc as any).to_str() : doc.toString(),
    applyPatch: (doc: Document, patch: unknown) => {
      // console.log("applyPatch", patch);
      return ((doc as any).apply_patch ?? doc.applyPatch).call(doc, patch);
    },
    applyPatchBatch: (doc: Document, patches: unknown[]) => {
      const applyBatch =
        (doc as any).apply_patch_batch ?? (doc as any).applyPatchBatch;
      if (typeof applyBatch === "function") {
        return applyBatch.call(doc, patches);
      }
      return (patches as unknown[]).reduce<Document>(
        (current, patch) =>
          ((current as any).apply_patch ?? current.applyPatch).call(
            current,
            patch,
          ),
        doc,
      );
    },
    makePatch: (a: Document, b: Document) =>
      ((a as any).make_patch ?? a.makePatch).call(a, b),
    // Exact values for text: every patch applies to the value of its own
    // parents and concurrent heads merge three-way from their common
    // ancestor, instead of fuzzy-applying concurrent patches to each other's
    // text (which could delete or duplicate the wrong text).
    ...(doctype.type === "string"
      ? {
          merge3: stringMerge3<Document>(fromStr, (doc) => doc.to_str()),
        }
      : doctype.type === "db" && doctype.opts?.primary_keys?.length > 0
        ? {
            merge3: dbMerge3<Document>(fromStr, (doc) => doc.to_str(), {
              primaryKeys: doctype.opts?.primary_keys,
              stringCols: doctype.opts?.string_cols ?? [],
            }),
          }
        : {}),
  };
}

/*
The patch graph of a document's stored records (decoded stream messages, in
stream order), as SyncDoc's patchflow session builds it when it opens them:
each record through patchFromRecord and toPatchflowEnvelope, all added at
once, with the session's defaults.
*/
export function graphFromRecords({
  records,
  codec,
}: {
  records: unknown[];
  codec: DocCodec;
}): PatchGraph {
  const graph = new PatchGraph({ codec });
  graph.add(
    records.map((record) =>
      toPatchflowEnvelope(patchFromRecord({ x: fromJS(record) as any })),
    ),
  );
  return graph;
}
