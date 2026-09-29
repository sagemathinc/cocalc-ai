/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import { createLiteCollaborationCensus } from "./census";

test("path-free operator revision recovers a blocked walk after cleanup and is stable on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-census-recovery-"));
  const root = join(directory, "home");
  mkdirSync(root);
  writeFileSync(join(root, "irrelevant.txt"), "not a chat");
  writeFileSync(join(root, "never-registered.chat"), "[]");
  const project_id = randomUUID();
  const journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  const env = { COCALC_COLLABORATORS_CENSUS_DIRECTORY_ENTRIES: "1" };
  const options = {
    inventory: true,
    filename: join(directory, "census.sqlite"),
    root,
    project_id,
    account_id: randomUUID(),
    now: () => 0,
    enabled: async () => true,
    current: async () => ({ run_id: null }),
    report: async () => {},
    onError: jest.fn(),
    policy: censusPolicyFromEnvironment(env),
    createFilesystem: jest.fn(
      () =>
        ({
          openDirectoryStream: async (path: string) =>
            opendir(join(root, path)),
          close: () => {},
        }) as any,
    ),
  };
  let census = createLiteCollaborationCensus(options);
  try {
    await census.producer.step(journal);
    const blocked = census.store.status(project_id)!;
    expect(blocked.coverage).toBe("partial");
    expect(blocked.blocked_directories).toBe(1);
    expect(journal.sources()).toEqual([]);
    unlinkSync(join(root, "irrelevant.txt"));
    await census.producer.close();
    census = createLiteCollaborationCensus(options);
    await census.producer.step(journal);
    expect(census.store.status(project_id)?.run.run_id).toBe(
      blocked.run.run_id,
    );
    await census.producer.close();
    options.policy = censusPolicyFromEnvironment({
      ...env,
      COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION: "cleanup-1",
    });
    census = createLiteCollaborationCensus(options);
    await census.producer.step(journal);
    const recovered = census.store.status(project_id)!;
    expect(recovered).toMatchObject({
      coverage: "complete",
      candidates: 1,
      previous: { run_id: blocked.run.run_id, coverage: "partial" },
    });
    expect(journal.sources()).toEqual([
      { project_id, chat_path: join(root, "never-registered.chat") },
    ]);
    await census.producer.close();
    census = createLiteCollaborationCensus(options);
    await census.producer.step(journal);
    expect(census.store.status(project_id)).toEqual(recovered);
    expect(options.createFilesystem).toHaveBeenCalledTimes(2);
  } finally {
    await census.producer.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Lite scope changes replace compacted summaries without reusing old run authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-census-scope-"));
  const root = join(directory, "home");
  mkdirSync(root);
  const project_id = randomUUID();
  const journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  const options = {
    inventory: true,
    filename: join(directory, "census.sqlite"),
    root,
    project_id,
    account_id: randomUUID(),
    now: () => 0,
    enabled: async () => true,
    current: async () => ({ run_id: null }),
    report: async () => {},
    onError: jest.fn(),
    createFilesystem: jest.fn(
      () =>
        ({
          openDirectoryStream: async () => ({
            read: async () => null,
            close: async () => {},
          }),
          close: () => {},
        }) as any,
    ),
  };
  let census = createLiteCollaborationCensus(options);
  try {
    await census.producer.step(journal);
    const first = census.store.status(project_id)!;
    expect(census.store.usage().frontiers).toBe(0);
    await census.producer.close();
    census = createLiteCollaborationCensus(options);
    await census.producer.step(journal);
    expect(census.store.status(project_id)).toEqual(first);
    expect(options.createFilesystem).toHaveBeenCalledTimes(1);
    await census.producer.close();
    census = createLiteCollaborationCensus({
      ...options,
      excluded_paths: [join(root, "private")],
    });
    await census.producer.step(journal);
    const changed = census.store.status(project_id)!;
    expect(changed.run.run_id).not.toBe(first.run.run_id);
    expect(changed.run.excluded_paths).toContain(join(root, "private"));
    expect(census.store.isCurrent(first.run)).toBe(false);
    await census.producer.close();
    renameSync(root, join(directory, "old-home"));
    mkdirSync(root);
    census = createLiteCollaborationCensus(options);
    await census.producer.step(journal);
    expect(census.store.status(project_id)?.run.volume_id).not.toBe(
      changed.run.volume_id,
    );
    expect(census.store.isCurrent(changed.run)).toBe(false);
    expect(options.onError).not.toHaveBeenCalled();
  } finally {
    await census.producer.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
