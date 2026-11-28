/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  ARTIFACT_CATALOG_LIMIT_ERRORS,
  type ArtifactCatalogSnapshot,
} from "@cocalc/util/artifact-catalog";
import {
  ArtifactCatalogBackoff,
  ArtifactCatalogBackoffError,
  artifactCatalogLimitScope,
  withArtifactCatalogBackoff,
} from "./backoff";
import { LogRateLimiter } from "../log-rate-limit";

const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const source = { project_id: projectA, chat_path: "/home/user/a.chat" };
const other = { project_id: projectA, chat_path: "/home/user/b.chat" };
const elsewhere = { project_id: projectB, chat_path: "/home/user/a.chat" };
const MINUTE = 60_000;
const annotate = (message: string) =>
  Error(
    `${message} - callHub: subject='hub.host.h.api', name='artifactCatalog.ingest', code='unknown'`,
  );

let now: number;
beforeEach(() => {
  now = 1_000_000;
});

describe("artifactCatalogLimitScope", () => {
  const project = [
    ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata,
    ARTIFACT_CATALOG_LIMIT_ERRORS.projectMutationBudget,
    ARTIFACT_CATALOG_LIMIT_ERRORS.projectSources,
    ARTIFACT_CATALOG_LIMIT_ERRORS.projectOwnerUnavailable,
  ];
  test.each(project)("%s backs off the whole project", (message) => {
    expect(artifactCatalogLimitScope(Error(message))).toBe("project");
    expect(artifactCatalogLimitScope(annotate(message))).toBe("project");
    expect(artifactCatalogLimitScope(Error(`Error: ${message}`))).toBe(
      "project",
    );
  });

  test("an oversized chat backs off only its source", () => {
    const message = ARTIFACT_CATALOG_LIMIT_ERRORS.sourceReadLimit;
    expect(artifactCatalogLimitScope(Error(message))).toBe("source");
    expect(artifactCatalogLimitScope(annotate(message))).toBe("source");
  });

  test.each([
    "read failed",
    "artifact catalog ingestion busy; retry later",
    "stale artifact catalog writer epoch",
    `prefix ${ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata}`,
    `${ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata} suffix`,
  ])("%s keeps the journal's normal retry", (message) => {
    expect(artifactCatalogLimitScope(Error(message))).toBeUndefined();
    expect(artifactCatalogLimitScope(annotate(message))).toBeUndefined();
  });
});

describe("ArtifactCatalogBackoff", () => {
  const metadata = Error(ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata);

  test("doubles from one minute and caps at one hour", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now });
    const delays: number[] = [];
    for (let i = 0; i < 9; i++)
      delays.push(backoff.failure(source, metadata)!.retry_in_ms);
    expect(delays).toEqual(
      [1, 2, 4, 8, 16, 32, 60, 60, 60].map((m) => m * MINUTE),
    );
  });

  test("blocks every source of the failing project until the delay passes", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now });
    backoff.failure(source, metadata);
    expect(() => backoff.check(source)).toThrow(ArtifactCatalogBackoffError);
    expect(() => backoff.check(other)).toThrow(ArtifactCatalogBackoffError);
    expect(() => backoff.check(elsewhere)).not.toThrow();
    now += MINUTE - 1;
    expect(() => backoff.check(other)).toThrow(ArtifactCatalogBackoffError);
    now += 1;
    expect(() => backoff.check(other)).not.toThrow();
  });

  test("a read-limit failure blocks only that chat", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now });
    backoff.failure(
      source,
      Error(ARTIFACT_CATALOG_LIMIT_ERRORS.sourceReadLimit),
    );
    expect(() => backoff.check(source)).toThrow(ArtifactCatalogBackoffError);
    expect(() => backoff.check(other)).not.toThrow();
  });

  test("other errors and discovery errors record nothing", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now });
    expect(backoff.failure(source, Error("read failed"))).toBeUndefined();
    expect(backoff.failure(undefined, metadata)).toBeUndefined();
    expect(backoff.size).toBe(0);
  });

  test("only the failing source's delivery clears the project", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now });
    backoff.failure(source, metadata);
    backoff.success(other, "all");
    expect(() => backoff.check(source)).toThrow(ArtifactCatalogBackoffError);
    expect(backoff.failure(source, metadata)!.failures).toBe(2);
    backoff.success(source, "source");
    expect(() => backoff.check(source)).toThrow(ArtifactCatalogBackoffError);
    backoff.success(source, "all");
    expect(() => backoff.check(source)).not.toThrow();
    expect(backoff.failure(source, metadata)!.failures).toBe(1);
  });

  test("memory stays bounded", () => {
    const backoff = new ArtifactCatalogBackoff({ now: () => now, maxKeys: 3 });
    for (let i = 0; i < 10; i++)
      backoff.failure(
        { project_id: `${i}`.padStart(8, "0"), chat_path: "/a.chat" },
        metadata,
      );
    expect(backoff.size).toBe(3);
  });
});

describe("withArtifactCatalogBackoff", () => {
  const CANARY = "CANARY-sk-live-0123456789";
  const snapshot: ArtifactCatalogSnapshot = {
    ...source,
    schema_version: 1,
    epoch: "epoch",
    sequence: 2,
    items: [
      {
        thread_id: "thread",
        artifact_id: "artifact",
        kind: "markdown",
        title: CANARY,
        description: CANARY.repeat(1000),
        created_at: 1,
        publication: { operation_id: "op", message_id: "msg" },
      },
    ],
  };

  function setup() {
    const logger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
    const inner = {
      read: jest.fn(async () => snapshot.items),
      send: jest.fn(async () => {}),
      register: jest.fn(async () => ({ epoch: "epoch" })),
    };
    const wrapped = withArtifactCatalogBackoff(
      inner,
      logger,
      new ArtifactCatalogBackoff({ now: () => now }),
      new LogRateLimiter({ now: () => now }),
    );
    return { logger, inner, wrapped };
  }

  test("a capacity failure stops reads, sends and registrations for the project", async () => {
    const { inner, wrapped } = setup();
    wrapped.onError(
      snapshot,
      Error(ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata),
    );
    await expect(
      wrapped.read({ ...other, epoch: "e", generation: 1 }),
    ).rejects.toThrow(ArtifactCatalogBackoffError);
    await expect(wrapped.send(snapshot)).rejects.toThrow(
      ArtifactCatalogBackoffError,
    );
    await expect(
      wrapped.register({
        ...other,
        registration_id: "r",
        expected_epoch: null,
      }),
    ).rejects.toThrow(ArtifactCatalogBackoffError);
    expect(inner.read).not.toHaveBeenCalled();
    expect(inner.send).not.toHaveBeenCalled();
    expect(inner.register).not.toHaveBeenCalled();
    await expect(
      wrapped.read({ ...elsewhere, epoch: "e", generation: 1 }),
    ).resolves.toEqual(snapshot.items);
    now += MINUTE;
    await wrapped.send(snapshot);
    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  test("other errors keep the existing retry path", async () => {
    const { inner, wrapped } = setup();
    wrapped.onError(snapshot, Error("stale artifact catalog writer epoch"));
    await wrapped.send(snapshot);
    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  test("logs compact lines without source content at every level", () => {
    const { logger, wrapped } = setup();
    wrapped.onError(
      snapshot,
      Error(ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata),
    );
    wrapped.onError(snapshot, Error("read failed"));
    wrapped.onError(undefined, Error("discovery failed"));
    wrapped.onError(snapshot, new ArtifactCatalogBackoffError());
    expect(logger.warn.mock.calls).toEqual([
      [
        "catalog indexing backed off",
        {
          project_id: projectA,
          chat_path: source.chat_path,
          error: ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata,
          scope: "project",
          failures: 1,
          retry_in_ms: MINUTE,
        },
      ],
      [
        "catalog indexing deferred",
        {
          project_id: projectA,
          chat_path: source.chat_path,
          error: "read failed",
        },
      ],
      [
        "catalog indexing deferred",
        {
          project_id: undefined,
          chat_path: undefined,
          error: "discovery failed",
        },
      ],
    ]);
    const all = JSON.stringify(
      Object.values(logger).map((fn) => fn.mock.calls),
    );
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain("items");
  });

  test("an error message cannot carry content past a short prefix", () => {
    const { logger, wrapped } = setup();
    wrapped.onError(source, Error(`parse failed: ${"x".repeat(500)}${CANARY}`));
    const [, fields] = logger.warn.mock.calls[0];
    expect(fields.error.length).toBeLessThanOrEqual(303);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CANARY);
  });

  test("repeats of the same deferred error are rate limited per source", () => {
    const { logger, wrapped } = setup();
    for (let i = 0; i < 50; i++) wrapped.onError(source, Error("read failed"));
    wrapped.onError(other, Error("read failed"));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    now += MINUTE;
    wrapped.onError(source, Error("read failed"));
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[2][1]).toEqual({
      project_id: projectA,
      chat_path: source.chat_path,
      error: "read failed",
      suppressed: 49,
    });
  });
});
