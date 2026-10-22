import assert from "node:assert/strict";
import test from "node:test";

import type { PersistStreamInfo } from "@cocalc/conat/project/persist-storage";
import { cleanupActions, selectStreams, trimActions } from "./edit-history";

const stream = (s: Partial<PersistStreamInfo>): PersistStreamInfo => ({
  name: "x",
  kind: "other",
  bytes: 1,
  reclaimable: 0,
  modified: 0,
  ...s,
});

const streams = [
  stream({
    name: "patchflow/home/user/a.md",
    kind: "edit-history",
    document: "/home/user/a.md",
    document_exists: true,
  }),
  stream({
    name: "patchflow/home/user/gone.md",
    kind: "edit-history",
    document: "/home/user/gone.md",
    document_exists: false,
  }),
  stream({
    name: "acp-log/home/user/a.chat",
    kind: "agent-log",
    document: "/home/user/a.chat",
    document_exists: true,
  }),
  stream({
    name: "patchflow/home/user/a.chat",
    kind: "edit-history",
    document: "/home/user/a.chat",
    document_exists: true,
  }),
  stream({ name: "project-log", kind: "project" }),
];

test("selectStreams takes stream names, or every stream of a document", () => {
  assert.deepEqual(
    selectStreams({
      streams,
      targets: ["project-log", "/home/user/a.chat"],
    }).map((s) => s.name),
    ["project-log", "acp-log/home/user/a.chat", "patchflow/home/user/a.chat"],
  );
  assert.deepEqual(
    selectStreams({
      streams,
      targets: ["/home/user/a.chat"],
      kind: "agent-log",
    }).map((s) => s.name),
    ["acp-log/home/user/a.chat"],
  );
});

test("selectStreams refuses what isn't there", () => {
  assert.throws(
    () => selectStreams({ streams, targets: ["/home/user/nope.md"] }),
    /no stream or document/,
  );
});

test("cleanupActions deletes the history of deleted documents and trims old logs", () => {
  assert.deepEqual(
    cleanupActions({ streams, deletedDocuments: true, before: 1000 }),
    [
      { op: "delete", name: "patchflow/home/user/gone.md" },
      { op: "trim", name: "acp-log/home/user/a.chat", before: 1000 },
      { op: "trim", name: "project-log", before: 1000 },
    ],
  );
});

test("cleanupActions drops archived history of every document", () => {
  assert.deepEqual(cleanupActions({ streams, archived: true }), [
    { op: "trim", name: "patchflow/home/user/a.md", archived: true },
    { op: "trim", name: "patchflow/home/user/gone.md", archived: true },
    { op: "trim", name: "patchflow/home/user/a.chat", archived: true },
  ]);
});

test("trimActions applies each flag only where it means something", () => {
  const chat = selectStreams({ streams, targets: ["/home/user/a.chat"] });
  assert.deepEqual(trimActions({ selected: chat, before: 1000 }), [
    { op: "trim", name: "acp-log/home/user/a.chat", before: 1000 },
  ]);
  assert.deepEqual(trimActions({ selected: chat, archived: true }), [
    { op: "trim", name: "patchflow/home/user/a.chat", archived: true },
  ]);
  assert.deepEqual(
    trimActions({ selected: chat, before: 1000, archived: true }),
    [
      { op: "trim", name: "acp-log/home/user/a.chat", before: 1000 },
      { op: "trim", name: "patchflow/home/user/a.chat", archived: true },
    ],
  );
});

test("trimActions refuses when nothing selected can be trimmed that way", () => {
  const md = selectStreams({ streams, targets: ["/home/user/a.md"] });
  assert.throws(
    () => trimActions({ selected: md, before: 1000 }),
    /--older-than applies to logs/,
  );
  const log = selectStreams({ streams, targets: ["project-log"] });
  assert.throws(
    () => trimActions({ selected: log, archived: true }),
    /--archived applies to edit histories/,
  );
});
