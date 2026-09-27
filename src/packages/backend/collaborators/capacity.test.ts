/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaboratorsService } from "./service";
import {
  journalCapacityFromEnvironment,
  validateJournalCapacity,
} from "./capacity";
import type { CollaborationJournalCapacity } from "./capacity";

test("journal defaults and explicit source/byte budgets are validated", () => {
  expect(journalCapacityFromEnvironment({})).toEqual({
    sources: 10_000,
    bytes: 268435456,
  });
  expect(
    journalCapacityFromEnvironment({
      COCALC_COLLABORATORS_JOURNAL_SOURCES: "12000",
      COCALC_COLLABORATORS_JOURNAL_BYTES: "536870912",
    }),
  ).toEqual({ sources: 12_000, bytes: 536870912 });
});

test.each(["", "0", "-1", "1.1", " 100", "1e4", "Infinity", "1000001"])(
  "invalid source budget %p fails closed",
  (raw) => {
    expect(() =>
      journalCapacityFromEnvironment({
        COCALC_COLLABORATORS_JOURNAL_SOURCES: raw,
      }),
    ).toThrow(/invalid/);
  },
);
test.each([0, -1, NaN, Infinity, 1.1, 4294967297])(
  "invalid byte budget %p fails closed",
  (bytes) => {
    expect(() => validateJournalCapacity({ sources: 100, bytes })).toThrow(
      /invalid/,
    );
    expect(() =>
      journalCapacityFromEnvironment({
        COCALC_COLLABORATORS_JOURNAL_BYTES: String(bytes),
      }),
    ).toThrow(/invalid/);
  },
);

test("runtime admission supports 1000 x 11 sources, restart and lower budgets without eviction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "collaborators-capacity-"));
  let service: CollaboratorsService | undefined;
  const setup = (journalCapacity?: CollaborationJournalCapacity) =>
    new CollaboratorsService({
      filename: join(directory, "journal.sqlite"),
      journalCapacity,
      read: async () => ({ resources: [], activity_ids: {} }),
      writerState: async () => null,
      register: async () => ({ epoch: "epoch" }),
      send: async () => ({ revision: 1, replayed: false }),
      discover: async () => [],
      onError: jest.fn(),
    });
  const source = (project: number, file: number) => ({
    project_id: `00000000-0000-4000-8000-${String(project).padStart(12, "0")}`,
    chat_path: `/home/user/unnamed-${file}.chat`,
    run_id: `census-${project}`,
  });
  const count = () => {
    let after = "",
      total = 0;
    for (;;) {
      const page = service!.journal.sources(after, 100);
      expect(page.length).toBeLessThanOrEqual(100);
      if (!page.length) return total;
      total += page.length;
      const last = page[page.length - 1];
      after = `${last.project_id}:${last.chat_path}`;
    }
  };
  const key = "COCALC_COLLABORATORS_JOURNAL_SOURCES";
  const previous = process.env[key];
  try {
    process.env[key] = "11000";
    expect(() => setup({ sources: NaN, bytes: 268435456 })).toThrow(/invalid/);
    service = setup();
    for (let project = 1; project <= 1000; project++)
      for (let file = 0; file < 11; file++)
        expect(
          service.journal.acceptCensusCandidate(source(project, file)),
        ).toBe(true);
    expect(count()).toBe(11_000);
    expect(() =>
      service!.journal.acceptCensusCandidate(source(1001, 0)),
    ).toThrow(/capacity/);
    expect(() => service!.journal.sources("", 101)).toThrow(/page limit/);
    await service.close();
    service = setup({ sources: 10_000, bytes: 268435456 });
    expect(count()).toBe(11_000);
    expect(service.journal.acceptCensusCandidate(source(1000, 10))).toBe(false);
    expect(() => service!.journal.touch(source(1000, 10))).not.toThrow();
    expect(() =>
      service!.journal.acceptCensusCandidate(source(1001, 0)),
    ).toThrow(/capacity/);
    await service.close();
    service = setup({ sources: 12_000, bytes: 268435456 });
    expect(service.journal.acceptCensusCandidate(source(1001, 0))).toBe(true);
    expect(count()).toBe(11_001);
    expect(service.journal.censusProgress(source(1000, 0).project_id)).toEqual({
      source_pending: 11,
      source_errors: 0,
    });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
