/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, webcrypto } from "node:crypto";
import { collaborationReference } from "./collaboration-references";
import {
  COLLABORATION_RELATION_MANIFEST_BYTES,
  COLLABORATION_RELATION_PAGE_BYTES,
  COLLABORATION_RELATION_PAGE_ROWS,
  COLLABORATION_RELATION_ROW_BYTES,
  COLLABORATION_RELATION_SET_BYTES,
  COLLABORATION_RELATION_SET_PAGES,
  COLLABORATION_RELATION_SET_ROWS,
  collaborationRelationBytes,
  collaborationRelationKey,
  collaborationRelationSetKey,
  validateCollaborationRelation,
  validateCollaborationRelationManifest,
  validateCollaborationRelationPage,
  validateCollaborationRelationSnapshot,
} from "./collaboration-relations";
import type {
  CollaborationParticipantRelation,
  CollaborationReferenceRelation,
  CollaborationRelation,
  CollaborationRelationManifest,
  CollaborationRelationPage,
  CollaborationRelationSnapshot,
  VerifiedCollaborationRelationSet,
} from "./collaboration-relations";
import {
  assertCollaborationRelationPageReplay,
  collaborationRelationActivation,
  createCollaborationRelationSet,
  decodeCollaborationRelationManifest,
  decodeCollaborationRelationPage,
  encodeCollaborationRelationManifest,
  encodeCollaborationRelationPage,
  verifyCollaborationRelationPage,
  verifyCollaborationRelationSet,
} from "./collaboration-relations-codec";

// Jest's sandbox may omit the Node 22 global even though production provides it.
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
beforeAll(() => {
  if (!globalThis.crypto?.subtle)
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
});
afterAll(() => {
  if (cryptoDescriptor)
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  else Reflect.deleteProperty(globalThis, "crypto");
});

const snapshot: CollaborationRelationSnapshot = {
  project_id: "a0000000-0000-4000-8000-000000000001",
  chat_path: "/home/user/.cocalc/collaborators.chat",
  epoch: "e0000000-0000-4000-8000-000000000001",
  sequence: 7,
};
const otherProject = "a0000000-0000-4000-8000-000000000002";
test("relation snapshots reject unsupported legacy chat files", () => {
  expect(() =>
    validateCollaborationRelationSnapshot({
      ...snapshot,
      chat_path: "/home/user/legacy.sage-chat",
    }),
  ).toThrow();
});
const source = {
  kind: "conversation" as const,
  resource_id: "thread:native",
  thread_id: "native",
};
const account = (n: number) =>
  `b0000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const participant = (n: number): CollaborationParticipantRelation => ({
  kind: "participant",
  source: { ...source },
  account_id: account(n),
});
const reference = (n = 0): CollaborationReferenceRelation => ({
  kind: "reference",
  source: { ...source },
  message_id: `message-${n.toString().padStart(6, "0")}`,
  reference: {
    version: 1,
    target: {
      project_id: otherProject,
      kind: "artifact",
      resource_id: "artifact:native",
    },
  },
});
function ordered(rows: CollaborationRelation[]) {
  return rows.sort((a, b) => {
    const x = collaborationRelationKey(a),
      y = collaborationRelationKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
async function build(
  rows: CollaborationRelation[] = [participant(1), reference()],
  version = snapshot,
) {
  const pages: CollaborationRelationPage[] = [];
  const manifest = await createCollaborationRelationSet(
    version,
    ordered(rows),
    (page) => {
      pages.push(page);
    },
  );
  return { manifest, pages };
}
function oracleHash(domain: "page" | "set", body: unknown) {
  return createHash("sha256")
    .update(
      `cocalc-collaboration-relation-${domain}-v1\n${JSON.stringify(body)}`,
    )
    .digest("hex");
}
function rehashPage(page: CollaborationRelationPage) {
  const { digest: _digest, ...body } = page;
  return { ...body, digest: oracleHash("page", body) };
}

describe("relation contracts", () => {
  it("declares independent wire, row, set, and manifest budgets", () => {
    expect(collaborationRelationBytes("\uefff")).toBe(3);
    expect([
      COLLABORATION_RELATION_PAGE_ROWS,
      COLLABORATION_RELATION_PAGE_BYTES,
      COLLABORATION_RELATION_ROW_BYTES,
      COLLABORATION_RELATION_SET_ROWS,
      COLLABORATION_RELATION_SET_BYTES,
      COLLABORATION_RELATION_SET_PAGES,
      COLLABORATION_RELATION_MANIFEST_BYTES,
    ]).toEqual([
      200,
      256 * 1024,
      4096,
      1_000_000,
      64 * 1024 * 1024,
      10_000,
      4096,
    ]);
  });

  it("normalizes UUID fields but preserves native and copied thread identities", () => {
    const row = participant(1);
    row.source = {
      kind: "agent",
      resource_id: "copy:ABC",
      thread_id: "Native-Thread",
    };
    row.account_id = row.account_id.toUpperCase();
    const validated = validateCollaborationRelation(row);
    expect(validated).toEqual({ ...row, account_id: account(1) });
    expect(validated.source).not.toBe(row.source);
    expect(
      collaborationRelationSetKey({
        ...snapshot,
        epoch: snapshot.epoch.toUpperCase(),
      }),
    ).toBe(collaborationRelationSetKey(snapshot));
  });

  it("preserves the selected cross-project typed target, not a name or locator", () => {
    const row = reference();
    expect(validateCollaborationRelation(row)).toEqual(row);
    expect(
      validateCollaborationRelation({
        ...row,
        source: { ...row.source, kind: "agent" },
      }),
    ).toEqual({ ...row, source: { ...row.source, kind: "agent" } });
  });

  it("accepts the authored reference codec's Unicode resource ID limit", () => {
    const row = reference();
    row.reference.target.resource_id = "\uefff".repeat(256);
    expect(
      collaborationReference({ ...row.reference, display_fallback: "target" }),
    ).toBeDefined();
    expect(validateCollaborationRelation(row)).toEqual(row);
    row.reference.target.resource_id += "x";
    expect(() => validateCollaborationRelation(row)).toThrow();
  });

  it.each([
    null,
    [],
    {},
    { ...participant(1), kind: "person" },
    { ...participant(1), account_id: "not-a-uuid" },
    { ...participant(1), source: { ...source, kind: "artifact" } },
    { ...participant(1), source: { ...source, thread_id: "" } },
    { ...participant(1), source: { ...source, thread_id: "\ud800" } },
    { ...participant(1), source: { ...source, resource_id: "a\u0000b" } },
    { ...participant(1), source: { ...source, resource_id: "x".repeat(257) } },
    {
      ...participant(1),
      source: { ...source, resource_id: "\uefff".repeat(86) },
    },
    { ...participant(1), source: { ...source, agent_id: account(2) } },
    { ...participant(1), canonical_resource_id: account(2) },
    { ...reference(), message_id: "" },
    { ...reference(), reference: { ...reference().reference, version: 2 } },
    {
      ...reference(),
      reference: { ...reference().reference, alias: "new-name" },
    },
    {
      ...reference(),
      reference: { ...reference().reference, display_fallback: "body" },
    },
    {
      ...reference(),
      reference: {
        version: 1,
        target: { ...reference().reference.target, kind: "person" },
      },
    },
    {
      ...reference(),
      reference: {
        version: 1,
        target: { ...reference().reference.target, chat_path: "/target.chat" },
      },
    },
    { ...reference(), content: "message body" },
  ])("rejects malformed or non-metadata relation %#", (value) => {
    expect(() => validateCollaborationRelation(value)).toThrow();
  });

  it.each([
    { ...snapshot, chat_path: "relative.chat" },
    { ...snapshot, chat_path: "/home//source.chat" },
    { ...snapshot, chat_path: "/home/./source.chat" },
    { ...snapshot, chat_path: "/home/../source.chat" },
    { ...snapshot, chat_path: "/home/source.txt" },
    { ...snapshot, chat_path: "/home/\nsource.chat" },
    { ...snapshot, project_id: "stranger" },
    { ...snapshot, epoch: "old" },
    { ...snapshot, sequence: 0 },
    { ...snapshot, sequence: -1 },
    { ...snapshot, sequence: 1.5 },
    { ...snapshot, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, sequence: "7" },
    { ...snapshot, set_id: "unrelated-upload-id" },
  ])("rejects invalid source fence %#", (value) => {
    expect(() => validateCollaborationRelationSnapshot(value)).toThrow();
  });

  it("orders Unicode keys identically as ASCII/binary database keys", () => {
    const rows = ["\uefff", "\ud83d\ude00", "\\u1234", '"quoted"'].map(
      (thread_id) => ({
        ...participant(1),
        source: { ...source, thread_id },
      }),
    );
    const keys = rows.map(collaborationRelationKey);
    expect(keys.every((key) => /^[\x00-\x7f]+$/.test(key))).toBe(true);
    expect([...keys].sort()).toEqual(
      [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    expect(new Set(keys).size).toBe(rows.length);
  });

  it("keeps message, source, copy namespace and target kind in edge identity", () => {
    const original = reference();
    const variants: CollaborationRelation[] = [
      original,
      { ...original, message_id: "another-message" },
      {
        ...original,
        source: { ...source, thread_id: "another-native-thread" },
      },
      { ...original, source: { ...source, resource_id: "copy:native" } },
      {
        ...original,
        reference: {
          version: 1,
          target: { ...original.reference.target, kind: "agent" },
        },
      },
      {
        ...original,
        reference: {
          version: 1,
          target: {
            ...original.reference.target,
            project_id: snapshot.project_id,
          },
        },
      },
    ];
    expect(new Set(variants.map(collaborationRelationKey)).size).toBe(
      variants.length,
    );
    expect(collaborationRelationKey(original)).toBe(
      collaborationRelationKey(JSON.parse(JSON.stringify(original))),
    );
  });
});

describe("complete immutable relation sets", () => {
  it("round-trips 1000 participants plus message references without truncation", async () => {
    const rows = [
      ...Array.from({ length: 1000 }, (_, n) => participant(n)),
      reference(),
    ];
    const { manifest, pages } = await build(rows);
    expect(manifest).toMatchObject({
      page_count: 6,
      participant_count: 1000,
      reference_count: 1,
    });
    expect(pages.map((p) => p.rows.length)).toEqual([
      200, 200, 200, 200, 200, 1,
    ]);
    expect(pages.flatMap((p) => p.rows)).toContainEqual(participant(999));
    const decoded = await Promise.all(
      pages.map(async (p) =>
        decodeCollaborationRelationPage(
          await encodeCollaborationRelationPage(p),
          snapshot,
        ),
      ),
    );
    const decodedManifest = decodeCollaborationRelationManifest(
      encodeCollaborationRelationManifest(manifest),
    );
    expect(
      await verifyCollaborationRelationSet(decodedManifest, decoded),
    ).toEqual(manifest);
    expect(manifest.byte_count).toBe(
      pages.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0),
    );
  });

  it("uses domain-separated SHA-256 over canonical content and ordered page hashes", async () => {
    const { manifest, pages } = await build();
    const { digest: pageDigest, ...body } = pages[0];
    expect(pageDigest).toBe(oracleHash("page", body));
    const { digest, ...manifestBody } = manifest;
    expect(digest).toBe(
      oracleHash("set", {
        ...manifestBody,
        page_digests: pages.map((p) => p.digest),
      }),
    );
    expect(pageDigest).not.toBe(oracleHash("set", body));
  });

  it("canonicalizes object field order without changing row order or meaning", async () => {
    const a = await build();
    const row = participant(1);
    const reordered = {
      account_id: row.account_id,
      source: {
        thread_id: source.thread_id,
        resource_id: source.resource_id,
        kind: source.kind,
      },
      kind: row.kind,
    };
    const b = await build([reordered, reference()]);
    expect(b).toEqual(a);
    const page = a.pages[0];
    expect(
      await decodeCollaborationRelationPage(
        JSON.stringify({
          digest: page.digest,
          rows: page.rows,
          page: page.page,
          snapshot: page.snapshot,
          version: page.version,
        }),
      ),
    ).toEqual(page);
  });

  it("splits pages by actual UTF-8 envelope bytes, not just row count", async () => {
    const rows = Array.from({ length: 200 }, (_, n) => {
      const row = reference(n);
      row.source.resource_id = "r".repeat(256);
      row.source.thread_id = "t".repeat(256);
      row.message_id += "m".repeat(230);
      row.reference.target.resource_id = "\uefff".repeat(256);
      return row;
    });
    const { manifest, pages } = await build(rows);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].rows.length).toBeLessThan(COLLABORATION_RELATION_PAGE_ROWS);
    for (const page of pages)
      expect(
        Buffer.byteLength(await encodeCollaborationRelationPage(page)),
      ).toBeLessThanOrEqual(COLLABORATION_RELATION_PAGE_BYTES);
    expect(await verifyCollaborationRelationSet(manifest, pages)).toEqual(
      manifest,
    );
  });

  it("requires an explicit valid empty manifest, never absence or an empty page", async () => {
    const { manifest, pages } = await build([]);
    expect(manifest).toMatchObject({
      page_count: 0,
      participant_count: 0,
      reference_count: 0,
      byte_count: 0,
    });
    expect(await verifyCollaborationRelationSet(manifest, pages)).toEqual(
      manifest,
    );
    await expect(
      verifyCollaborationRelationSet(undefined, []),
    ).rejects.toThrow();
    const nonempty = await build();
    await expect(
      verifyCollaborationRelationPage({ ...nonempty.pages[0], rows: [] }),
    ).rejects.toThrow();
  });

  it("preserves provenance when multiple native threads will bind to one registered agent", async () => {
    const rows = ["old-thread", "current-thread"].map((thread_id) => ({
      ...participant(1),
      source: {
        kind: "agent" as const,
        resource_id: `agent-thread:${thread_id}`,
        thread_id,
      },
    }));
    const { manifest, pages } = await build(rows);
    expect(manifest.participant_count).toBe(2);
    expect(pages[0].rows.map((row) => row.source)).toEqual(
      ordered(rows).map((row) => row.source),
    );
    expect(await verifyCollaborationRelationSet(manifest, pages)).toEqual(
      manifest,
    );
  });

  it("stages bounded pages while consuming an async source", async () => {
    let consumed = 0;
    const stagedAt: number[] = [];
    async function* rows() {
      for (let n = 0; n < 401; n++) {
        consumed++;
        yield participant(n);
      }
    }
    const manifest = await createCollaborationRelationSet(
      snapshot,
      rows(),
      () => {
        stagedAt.push(consumed);
      },
    );
    expect(stagedAt).toEqual([200, 400, 401]);
    expect(manifest.participant_count).toBe(401);
  });

  it("does not return a complete set after the source fails mid-stream", async () => {
    const staged: CollaborationRelationPage[] = [];
    async function* rows() {
      for (let n = 0; n < 201; n++) yield participant(n);
      throw Error("archive changed during enumeration");
    }
    await expect(
      createCollaborationRelationSet(snapshot, rows(), (p) => {
        staged.push(p);
      }),
    ).rejects.toThrow("archive changed");
    expect(staged.length).toBe(1);
  });

  it("stops source consumption when durable staging fails", async () => {
    let consumed = 0;
    async function* rows() {
      for (let n = 0; n < 1000; n++) {
        consumed++;
        yield participant(n);
      }
    }
    await expect(
      createCollaborationRelationSet(snapshot, rows(), () => {
        throw Error("journal full");
      }),
    ).rejects.toThrow("journal full");
    expect(consumed).toBe(200);
  });

  it.each([
    [participant(1), participant(1)],
    [participant(2), participant(1)],
    [reference(), reference()],
  ])("rejects duplicate or unordered producer input %#", async (...rows) => {
    await expect(
      createCollaborationRelationSet(snapshot, rows, () => {}),
    ).rejects.toThrow("ordered and unique");
  });

  it("rejects missing, reordered, duplicated and extra pages", async () => {
    const { manifest, pages } = await build(
      Array.from({ length: 401 }, (_, n) => participant(n)),
    );
    for (const invalid of [
      [],
      pages.slice(0, 2),
      [pages[0], pages[2]],
      [pages[1], pages[0], pages[2]],
      [pages[0], pages[0], pages[2]],
      [...pages, pages[2]],
    ])
      await expect(
        verifyCollaborationRelationSet(manifest, invalid),
      ).rejects.toThrow();
  });

  it("rejects changed content even if its identity and ordering remain valid", async () => {
    const { pages } = await build([participant(1)]);
    await expect(
      verifyCollaborationRelationPage({ ...pages[0], rows: [participant(2)] }),
    ).rejects.toThrow("digest mismatch");
  });

  it("rejects valid pages from a different set at the same snapshot sequence", async () => {
    const a = await build([participant(1)]),
      b = await build([participant(2)]);
    await expect(
      verifyCollaborationRelationSet(a.manifest, b.pages),
    ).rejects.toThrow("set digest mismatch");
    await expect(
      assertCollaborationRelationPageReplay(a.pages[0], b.pages[0]),
    ).rejects.toThrow("conflicting immutable");
  });

  it("accepts exact lost-ACK retries", async () => {
    const a = await build(),
      b = await build();
    await expect(
      assertCollaborationRelationPageReplay(a.pages[0], b.pages[0]),
    ).resolves.toBeUndefined();
    expect(a.manifest).toEqual(b.manifest);
  });

  it.each([
    { ...snapshot, project_id: otherProject },
    { ...snapshot, chat_path: "/other.chat" },
    { ...snapshot, epoch: "e0000000-0000-4000-8000-000000000002" },
    { ...snapshot, sequence: snapshot.sequence + 1 },
  ])("rejects mixed source/epoch/sequence pages %#", async (version) => {
    const a = await build(),
      b = await build(undefined, version);
    await expect(
      verifyCollaborationRelationSet(a.manifest, b.pages),
    ).rejects.toThrow("snapshot mismatch");
    await expect(
      assertCollaborationRelationPageReplay(a.pages[0], b.pages[0]),
    ).rejects.toThrow("snapshot mismatch");
  });

  it("rejects cross-page duplicate edges even with valid page hashes", async () => {
    const { manifest, pages } = await build(
      Array.from({ length: 201 }, (_, n) => participant(n)),
    );
    const repeated = rehashPage({ ...pages[1], rows: [pages[0].rows[199]] });
    expect(await verifyCollaborationRelationPage(repeated)).toEqual(repeated);
    await expect(
      verifyCollaborationRelationSet(manifest, [pages[0], repeated]),
    ).rejects.toThrow("ordered and unique");
  });

  it("rejects manifest count, byte and digest disagreement", async () => {
    const { manifest, pages } = await build();
    for (const override of [
      { participant_count: 2 },
      { reference_count: 0 },
      { byte_count: manifest.byte_count + 1 },
      { digest: "0".repeat(64) },
    ])
      await expect(
        verifyCollaborationRelationSet({ ...manifest, ...override }, pages),
      ).rejects.toThrow();
  });

  it.each([
    { version: 2 },
    { complete: false },
    { coverage: "partial" },
    { participant_count: COLLABORATION_RELATION_SET_ROWS + 1 },
    { participant_count: COLLABORATION_RELATION_SET_ROWS, reference_count: 1 },
    { page_count: COLLABORATION_RELATION_SET_PAGES + 1 },
    { byte_count: COLLABORATION_RELATION_SET_BYTES + 1 },
    { digest: "sha1" },
    { page_count: 0 },
    { byte_count: 0 },
    { participant_count: NaN },
    { reference_count: Infinity },
  ])(
    "rejects unsupported, partial or over-budget manifests %#",
    async (override) => {
      const { manifest } = await build();
      expect(() =>
        validateCollaborationRelationManifest({ ...manifest, ...override }),
      ).toThrow();
    },
  );

  it("rejects incompatible page versions and page/row budgets", async () => {
    const { pages } = await build();
    for (const override of [
      { version: 2 },
      { page: -1 },
      { page: 0.5 },
      { page: COLLABORATION_RELATION_SET_PAGES },
      {
        rows: Array.from(
          { length: COLLABORATION_RELATION_PAGE_ROWS + 1 },
          (_, n) => participant(n),
        ),
      },
    ])
      expect(() =>
        validateCollaborationRelationPage({ ...pages[0], ...override }),
      ).toThrow();
  });

  it("enforces raw JSON wire byte budgets before parsing", async () => {
    expect(() =>
      decodeCollaborationRelationManifest(
        " ".repeat(COLLABORATION_RELATION_MANIFEST_BYTES + 1),
      ),
    ).toThrow("wire byte limit");
    await expect(
      decodeCollaborationRelationPage(
        "\uefff".repeat(COLLABORATION_RELATION_PAGE_BYTES / 2),
      ),
    ).rejects.toThrow("wire byte limit");
    expect(() => decodeCollaborationRelationManifest("{")).toThrow();
    await expect(decodeCollaborationRelationPage("{")).rejects.toThrow();
  });
});

describe("activation fencing", () => {
  async function verified(version = snapshot, rows = [participant(1)]) {
    const set = await build(rows, version);
    return await verifyCollaborationRelationSet(set.manifest, set.pages);
  }

  it("requires a fully verified set at the admitted snapshot sequence", async () => {
    const set = await verified();
    expect(collaborationRelationActivation(set, snapshot)).toBe("activate");
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.snapshot)).toBe(true);
  });

  it("does not treat a decoded manifest or a type assertion as verified pages", async () => {
    const { manifest } = await build();
    const decoded = decodeCollaborationRelationManifest(
      encodeCollaborationRelationManifest(manifest),
    );
    expect(() =>
      collaborationRelationActivation(
        decoded as VerifiedCollaborationRelationSet,
        snapshot,
      ),
    ).toThrow("unverified relation set");
    const ready = await verified();
    expect(() =>
      collaborationRelationActivation({ ...ready }, snapshot),
    ).toThrow("unverified relation set");
  });

  it("reuses an exact committed set for a lost ACK or notification-only sequence", async () => {
    const set = await verified();
    expect(collaborationRelationActivation(set, snapshot, set)).toBe("reuse");
    expect(
      collaborationRelationActivation(set, { ...snapshot, sequence: 11 }, set),
    ).toBe("reuse");
  });

  it("does not accept a staged old set as a notification-only reuse", async () => {
    const set = await verified();
    expect(() =>
      collaborationRelationActivation(set, { ...snapshot, sequence: 11 }),
    ).toThrow("uncommitted old");
  });

  it("rejects a conflicting replay of the committed sequence", async () => {
    const a = await verified(),
      b = await verified(snapshot, [participant(2)]);
    expect(() => collaborationRelationActivation(b, snapshot, a)).toThrow(
      "conflicting committed",
    );
  });

  it("rejects a stale set after a newer set has committed", async () => {
    const old = await verified(),
      current = await verified({ ...snapshot, sequence: 8 });
    expect(() =>
      collaborationRelationActivation(
        old,
        { ...snapshot, sequence: 9 },
        current,
      ),
    ).toThrow("stale");
  });

  it("rejects a future set, even if supplied as the committed pointer", async () => {
    const set = await verified({ ...snapshot, sequence: 8 });
    expect(() => collaborationRelationActivation(set, snapshot, set)).toThrow(
      "future",
    );
  });

  it("accepts a newer complete set within the same admitted epoch", async () => {
    const a = await verified(),
      b = await verified({ ...snapshot, sequence: 8 });
    expect(collaborationRelationActivation(b, b.snapshot, a)).toBe("activate");
  });

  it("requires the authoritative epoch, not a comparison of opaque epochs", async () => {
    const a = await verified();
    const next = {
      ...snapshot,
      epoch: "e0000000-0000-4000-8000-000000000002",
      sequence: 1,
    };
    const b = await verified(next);
    expect(() => collaborationRelationActivation(a, next, a)).toThrow(
      "source/epoch mismatch",
    );
    expect(() => collaborationRelationActivation(b, snapshot, a)).toThrow(
      "source/epoch mismatch",
    );
    expect(collaborationRelationActivation(b, next, a)).toBe("activate");
  });

  it("does not reuse an identical-looking relation across projects or paths", async () => {
    const set = await verified();
    expect(() =>
      collaborationRelationActivation(set, {
        ...snapshot,
        project_id: otherProject,
      }),
    ).toThrow("source/epoch mismatch");
    const unrelated: CollaborationRelationManifest = {
      ...set,
      snapshot: { ...snapshot, chat_path: "/other.chat" },
    };
    expect(() =>
      collaborationRelationActivation(set, snapshot, unrelated),
    ).toThrow("source/epoch mismatch");
  });

  it("allows an explicitly verified empty replacement, but not an omitted manifest", async () => {
    const active = await verified();
    const next = { ...snapshot, sequence: 8 };
    const empty = await build([], next);
    const ready = await verifyCollaborationRelationSet(
      empty.manifest,
      empty.pages,
    );
    expect(collaborationRelationActivation(ready, next, active)).toBe(
      "activate",
    );
    expect(() => validateCollaborationRelationManifest(undefined)).toThrow();
  });
});
