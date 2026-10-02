#!/usr/bin/env node
/*
Incident replay kit for realtime collaborative editing.

Decodes a conat-persist stream database for a synced string document (for
example a Markdown file's patch stream), rebuilds every version with
patchflow, flags suspicious patches, and searches for the merge inputs that
reproduce a suspect patch. See
src/.agents/harden-realtime-collaborative-editing-plan-2026-09-30.md.

Usage:
  node sync-replay.mjs summary  <db> [--min-dup 200]
  node sync-replay.mjs versions <db> <outdir>
  node sync-replay.mjs explain  <db> <version> [--from N] [--to N]

Flags in the summary:
  MERGE   the patch has more than one parent
  BIG     inserts at least --min-dup characters
  DUP     inserts a block of at least --min-dup characters that already existed
          verbatim in its parent document (typical of a stale merge replay)
  REVERT  exactly undoes the previous patch, which came from another client

Real session databases contain private documents: keep them and derived
versions out of the repository.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const requireFromSync = createRequire(
  path.join(SRC_ROOT, "packages/sync/package.json"),
);
const requireFromConat = createRequire(
  path.join(SRC_ROOT, "packages/conat/package.json"),
);

export function loadPatches(dbPath, { msgpack } = {}) {
  msgpack ??= requireFromConat("@msgpack/msgpack");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT seq, raw, compress, encoding FROM messages ORDER BY seq")
      .all();
    let metadata;
    try {
      metadata = JSON.parse(
        db.prepare("SELECT metadata_json FROM stream_metadata").get()
          ?.metadata_json ?? "null",
      );
    } catch {
      metadata = null;
    }
    const patches = [];
    for (const row of rows) {
      let raw = Buffer.from(row.raw);
      if (row.compress === 1) raw = zstdDecompressSync(raw);
      const mesg =
        row.encoding === 0
          ? msgpack.decode(raw)
          : JSON.parse(raw.toString("utf8"));
      if (mesg?.patch == null || mesg.time == null) continue;
      patches.push({
        seq: row.seq,
        time: mesg.time,
        wall: mesg.wall,
        userId: mesg.user_id,
        parents: mesg.parents ?? [],
        version: mesg.version,
        isSnapshot: mesg.is_snapshot,
        snapshot: mesg.snapshot,
        file: mesg.file,
        patch:
          typeof mesg.patch === "string" ? JSON.parse(mesg.patch) : mesg.patch,
      });
    }
    return { patches, users: metadata?.users ?? [] };
  } finally {
    db.close();
  }
}

export function buildGraph(patches, pf = requireFromSync("patchflow")) {
  const codec = {
    fromString: (s) => new pf.StringDocument(s),
    toString: (d) => d.toString(),
    applyPatch: (d, p) => d.applyPatch(p),
    applyPatchBatch: (d, ps) => d.applyPatchBatch(ps),
    makePatch: (a, b) => a.makePatch(b),
  };
  const graph = new pf.PatchGraph({ codec });
  graph.add(patches);
  return graph;
}

function patchStats(patch) {
  let inserted = 0;
  let deleted = 0;
  const inserts = [];
  for (const [diffs] of patch) {
    for (const [op, text] of diffs) {
      if (op === 1) {
        inserted += text.length;
        inserts.push(text);
      } else if (op === -1) {
        deleted += text.length;
      }
    }
  }
  return { inserted, deleted, inserts };
}

const clientOf = (time) => String(time).split("_")[1] ?? "?";

export function summarize(patches, graph, { minDup = 200 } = {}) {
  const valueAt = (time) => graph.version(time).toString();
  const out = [];
  let previous;
  for (const p of [...patches].sort((a, b) => (a.time < b.time ? -1 : 1))) {
    const flags = [];
    const { inserted, deleted, inserts } = patchStats(p.patch);
    if (p.parents.length > 1) flags.push("MERGE");
    if (inserted >= minDup) flags.push("BIG");
    if (p.parents.length > 0) {
      const parentValue = valueAt(p.parents[0]);
      if (
        inserts.some((text) => {
          const probe = text.trim();
          return probe.length >= minDup && parentValue.includes(probe);
        })
      ) {
        flags.push("DUP");
      }
    }
    if (
      previous != null &&
      clientOf(previous.time) !== clientOf(p.time) &&
      p.parents.length === 1 &&
      p.parents[0] === previous.time &&
      previous.parents.length === 1 &&
      valueAt(p.time) === valueAt(previous.parents[0])
    ) {
      flags.push("REVERT");
    }
    out.push({
      version: p.version,
      time: p.time,
      client: clientOf(p.time),
      userId: p.userId,
      wall: p.wall,
      parents: p.parents.length,
      inserted,
      deleted,
      flags,
    });
    previous = p;
  }
  return out;
}

// Which (base, local) pair, merged onto the parent value the way
// SimpleInputMerge rebases (applyPatch(makePatch(base, local), remote)),
// reproduces the target version exactly?
export function explain(
  patches,
  graph,
  version,
  { from, to } = {},
  pf = requireFromSync("patchflow"),
) {
  const byVersion = new Map(patches.map((p) => [p.version, p]));
  const target = byVersion.get(version);
  if (!target) throw new Error(`no patch with version ${version}`);
  if (target.parents.length !== 1)
    throw new Error("explain needs a single-parent patch");
  const remote = graph.version(target.parents[0]).toString();
  const wanted = graph.version(target.time).toString();
  const lo = from ?? Math.max(1, version - 40);
  const hi = to ?? version - 1;
  const values = [];
  for (let v = lo; v <= hi; v++) {
    const p = byVersion.get(v);
    if (p) values.push([v, graph.version(p.time).toString()]);
  }
  const hits = [];
  for (const [lv, local] of values) {
    for (const [bv, base] of values) {
      const [merged] = pf.applyPatch(pf.makePatch(base, local), remote);
      if (merged === wanted) hits.push({ base: bv, local: lv });
    }
  }
  return { hits };
}

function main(argv) {
  const [command, dbPath, ...rest] = argv;
  const flag = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(rest[i + 1]);
  };
  if (!command || !dbPath) {
    console.error("usage: sync-replay.mjs summary|versions|explain <db> ...");
    process.exit(2);
  }
  const { patches, users } = loadPatches(dbPath);
  const graph = buildGraph(patches);
  if (command === "summary") {
    console.log(
      `patches: ${patches.length}  heads: ${graph.getHeads().length}`,
    );
    users.forEach((u, i) => console.log(`user ${i}: ${u}`));
    for (const r of summarize(patches, graph, {
      minDup: flag("min-dup", 200),
    })) {
      if (r.flags.length === 0 && !rest.includes("--all")) continue;
      console.log(
        `v${r.version}\tuser${r.userId}\t${r.client}\t${new Date(r.wall).toISOString()}\tparents=${r.parents}\t+${r.inserted}\t-${r.deleted}\t${r.flags.join(",")}`,
      );
    }
  } else if (command === "versions") {
    const outDir = rest[0];
    if (!outDir) throw new Error("versions needs an output directory");
    mkdirSync(outDir, { recursive: true });
    for (const p of patches) {
      writeFileSync(
        path.join(
          outDir,
          `v${String(p.version).padStart(4, "0")}-${clientOf(p.time)}.txt`,
        ),
        graph.version(p.time).toString(),
      );
    }
    console.log(`wrote ${patches.length} versions to ${outDir}`);
  } else if (command === "explain") {
    const version = Number(rest[0]);
    const { hits } = explain(patches, graph, version, {
      from: flag("from", undefined),
      to: flag("to", undefined),
    });
    if (hits.length === 0) {
      console.log(`no (base, local) pair reproduces v${version}`);
    } else {
      for (const h of hits)
        console.log(
          `v${version} = merge(base=v${h.base}, local=v${h.local}, remote=parent)`,
        );
    }
  } else {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
