/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import { CensusQuotaError } from "@cocalc/backend/collaborators/census-types";
import { getProject, nextCollaborationCensusProject } from "./sqlite/projects";
import { getRecordedProjectVolumeIdentity } from "./sqlite/project-volumes";
import { createHostedCollaborationCensus } from "./collaborators-census";
import {
  invalidateProjectVolumeLifecycle,
  resetProjectVolumeLifecycleForTesting,
} from "./project-volume-lifecycle";
jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(),
  nextCollaborationCensusProject: jest.fn(),
}));
jest.mock("./sqlite/hosts", () => ({ getLocalHostId: () => "host" }));
jest.mock("./sqlite/project-volumes", () => ({
  getRecordedProjectVolumeIdentity: jest.fn(),
}));
const project_id = randomUUID();
let directory: string,
  journal: CollaborationJournal,
  census: ReturnType<typeof createHostedCollaborationCensus> | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "host-census-"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  jest.clearAllMocks();
  resetProjectVolumeLifecycleForTesting();
  (getProject as jest.Mock).mockReturnValue({ state: "stopped" });
  (nextCollaborationCensusProject as jest.Mock).mockImplementation((after) =>
    after ? undefined : project_id,
  );
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue("volume-1");
});
afterEach(async () => {
  await census?.producer.close();
  census = undefined;
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function setup(
  now = Date.now,
  scheduling: "inventory" | "explicit" = "inventory",
) {
  const stream = {
    read: jest
      .fn()
      .mockResolvedValueOnce({
        name: "unknown.chat",
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      })
      .mockResolvedValue(null),
    close: jest.fn(async () => {}),
    assertCurrent: jest.fn(async () => {}),
  };
  const fs = {
    openDirectoryStream: jest.fn(async () => stream),
    close: jest.fn(),
  };
  const options = {
    filename: join(directory, "census.sqlite"),
    enabled: jest.fn(async () => true),
    getFilesystem: jest.fn(async () => fs as any),
    authorize: jest.fn(async () => {}),
    current: jest.fn(async () => ({ run_id: null })),
    report: jest.fn(async () => {}),
    onError: jest.fn(),
    now,
    scheduling,
  };
  census = createHostedCollaborationCensus(options);
  return { options, fs, stream };
}
test("explicit mode leaves cold inventory untouched and only a requested run opens files", async () => {
  let now = 0;
  const { options } = setup(() => now, "explicit");
  for (let day = 0; day < 3; day++) {
    now += 86400000;
    await census!.producer.step(journal);
  }
  expect(nextCollaborationCensusProject).not.toHaveBeenCalled();
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(census!.store.status(project_id)).toBeUndefined();
  const request = { project_id, run_id: randomUUID() };
  expect(await census!.requestReconciliation(request)).toEqual({
    admission: "accepted",
    run_id: request.run_id,
    replayed: false,
  });
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(await census!.requestReconciliation(request)).toEqual({
    admission: "accepted",
    run_id: request.run_id,
    replayed: true,
  });
  expect(
    await census!.requestReconciliation({
      project_id,
      run_id: randomUUID(),
      expected_run_id: request.run_id,
    }),
  ).toMatchObject({ admission: "deferred", reason: "BUSY" });
  await census!.producer.step(journal);
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
  expect(
    await census!.requestReconciliation({
      project_id,
      run_id: randomUUID(),
      expected_run_id: request.run_id,
    }),
  ).toMatchObject({ admission: "throttled", retry_after_ms: 300000 });
  now += 300000;
  const next = {
    project_id,
    run_id: randomUUID(),
    expected_run_id: request.run_id,
  };
  expect(await census!.requestReconciliation(next)).toMatchObject({
    admission: "accepted",
    run_id: next.run_id,
  });
  await expect(census!.requestReconciliation(request)).rejects.toThrow(
    "current run id",
  );
  await census!.producer.close();
  census = createHostedCollaborationCensus(options);
  expect(await census.requestReconciliation(next)).toMatchObject({
    admission: "accepted",
    replayed: true,
  });
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
});

test("explicit requests recheck disabled, owner denial, missing volume, and replacement fences", async () => {
  const { options } = setup(() => 0, "explicit");
  const request = { project_id, run_id: randomUUID() };
  options.enabled.mockResolvedValueOnce(false);
  await expect(census!.requestReconciliation(request)).rejects.toMatchObject({
    code: "DISABLED",
  });
  options.authorize.mockRejectedValueOnce(Error("owner denied"));
  await expect(census!.requestReconciliation(request)).rejects.toThrow(
    "owner denied",
  );
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValueOnce(
    undefined,
  );
  await expect(census!.requestReconciliation(request)).rejects.toMatchObject({
    code: "ENODEV",
  });
  options.authorize.mockImplementationOnce(async () => {
    (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue(
      "replaced-volume",
    );
  });
  await expect(census!.requestReconciliation(request)).rejects.toMatchObject({
    code: "ESTALE",
  });
  expect(census!.store.status(project_id)).toBeUndefined();
  expect(options.getFilesystem).not.toHaveBeenCalled();
});

test("explicit status is authorized, inert, and distinguishes discovery from ingestion", async () => {
  const { options } = setup(() => 0, "explicit");
  const request = { project_id, run_id: randomUUID() };
  expect(await census!.reconciliationStatus(request)).toEqual({
    state: "unknown",
  });
  expect(census!.store.status(project_id)).toBeUndefined();
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census!.requestReconciliation(request);
  expect(
    await census!.reconciliationStatus({ project_id, run_id: randomUUID() }),
  ).toEqual({ state: "unknown", current_run_id: request.run_id });
  expect(await census!.reconciliationStatus(request)).toMatchObject({
    state: "indexing",
    run_id: request.run_id,
    entries: 0,
  });
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census!.producer.step(journal);
  expect(await census!.reconciliationStatus(request)).toMatchObject({
    state: "discovered",
    run_id: request.run_id,
    candidates: 1,
  });
  options.authorize.mockRejectedValueOnce(Error("owner denied"));
  await expect(census!.reconciliationStatus(request)).rejects.toThrow(
    "owner denied",
  );
  options.authorize.mockImplementationOnce(async () => {
    options.enabled.mockResolvedValue(false);
  });
  await expect(census!.reconciliationStatus(request)).rejects.toMatchObject({
    code: "DISABLED",
  });
  options.enabled.mockResolvedValue(true);
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue(
    "replacement",
  );
  await expect(census!.reconciliationStatus(request)).rejects.toMatchObject({
    code: "ESTALE",
  });
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
});
test("stopped existing volume is streamed only by worker, and metadata reads are inert", async () => {
  const { options, fs } = setup();
  expect(census!.store.status(project_id)).toBeUndefined();
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census!.producer.step(journal);
  expect(fs.openDirectoryStream).toHaveBeenCalledWith(
    "/home/user",
    "/home/user",
  );
  expect(journal.sources()).toEqual([
    { project_id, chat_path: "/home/user/unknown.chat" },
  ]);
  expect(options.authorize).toHaveBeenCalled();
  expect(fs.close).toHaveBeenCalledTimes(1);
});
test("missing existing volume never opens filesystem or starts compute", async () => {
  const { options } = setup();
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue(undefined);
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
  expect(census!.store.status(project_id)).toMatchObject({
    coverage: "partial",
    errors: 1,
    run: { volume_id: "unavailable" },
  });
});
test("owner denial and volume replacement fence candidate handoff", async () => {
  const { options, stream } = setup();
  options.authorize.mockRejectedValueOnce(Error("wrong current host"));
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
  const run = census!.store.status(project_id)!.run;
  // Simulates an already retained candidate before host reassignment.
  census!.store.record(
    { run, path: run.root, depth: 0 },
    [{ name: "retained.chat", kind: "file" }],
    true,
  );
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue(
    "replacement",
  );
  await census!.producer.step(journal);
  expect(stream.read).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
  expect(census!.store.status(project_id)?.pending_candidates).toBe(1);
});
test("lifecycle change while streaming discards the uncommitted batch and closes handles", async () => {
  const { stream, fs } = setup();
  stream.assertCurrent.mockImplementationOnce(async () => {
    invalidateProjectVolumeLifecycle(project_id);
  });
  await census!.producer.step(journal);
  expect(journal.sources()).toEqual([]);
  expect(census!.store.status(project_id)?.candidates).toBe(0);
  expect(stream.close).toHaveBeenCalledTimes(1);
  expect(fs.close).toHaveBeenCalledTimes(1);
});
test("disabled worker and exam project do not open a volume", async () => {
  const { options } = setup();
  options.enabled.mockResolvedValue(false);
  await census!.producer.step(journal);
  expect(nextCollaborationCensusProject).not.toHaveBeenCalled();
  options.enabled.mockResolvedValue(true);
  (getProject as jest.Mock).mockReturnValue({ exam_run_id: randomUUID() });
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(census!.store.status(project_id)).toBeUndefined();
});

test("persisted admission sweep reaches unseen projects before hourly recrawls", async () => {
  const { options } = setup(() => 2 * 60 * 60_000);
  const ids = [project_id, randomUUID()].sort();
  (nextCollaborationCensusProject as jest.Mock).mockImplementation((after) =>
    ids.find((id) => id > after),
  );
  const old = census!.store.begin(
    {
      project_id: ids[0],
      run_id: randomUUID(),
      root: "/home/user",
      authority: "host:host",
      volume_id: "volume-1",
      policy_version: "home-no-links-or-mounts-v1",
      excluded_paths: ["/home/user/.snapshots", "/home/user/.trash"],
    },
    undefined,
    0,
  );
  census!.store.record({ run: old, path: old.root, depth: 0 }, [], true);
  await census!.producer.step(journal);
  expect(census!.store.status(ids[0])?.run.run_id).toBe(old.run_id);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census!.producer.close();
  census = createHostedCollaborationCensus(options);
  await census.producer.step(journal);
  expect(census.store.status(ids[1])?.traversal_complete).toBe(true);
  expect(census.store.status(ids[0])?.run.run_id).toBe(old.run_id);
  await census.producer.step(journal);
  expect(census.store.checkpoint("host-phase")).toBe("refresh");
  await census.producer.step(journal);
  expect(census.store.status(ids[0])?.run.run_id).not.toBe(old.run_id);
});

test("operator policy change drains retained handoffs before resetting a quota-blocked frontier", async () => {
  const { options } = setup(() => 0);
  const old = census!.store.begin({
    project_id,
    run_id: randomUUID(),
    root: "/home/user",
    authority: "host:host",
    volume_id: "volume-1",
    policy_version: "home-no-links-or-mounts-v1",
    excluded_paths: ["/home/user/.snapshots", "/home/user/.trash"],
  });
  const work = { run: old, path: old.root, depth: 0 };
  census!.store.record(work, [{ name: "retained.chat", kind: "file" }], false);
  census!.store.fail(work, new CensusQuotaError("entry_limit"), 0);
  await census!.producer.close();
  const nextOptions = {
    ...options,
    policy: censusPolicyFromEnvironment({
      COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION: "operator-2",
    }),
  };
  census = createHostedCollaborationCensus(nextOptions);
  await census.producer.step(journal);
  expect(census.store.status(project_id)?.run.run_id).toBe(old.run_id);
  expect(journal.sources()).toEqual([
    { project_id, chat_path: "/home/user/retained.chat" },
  ]);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census.producer.step(journal); // End the admission sweep.
  await census.producer.step(journal);
  const reset = census.store.status(project_id)!;
  expect(reset.run.run_id).not.toBe(old.run_id);
  expect(reset.previous).toMatchObject({
    run_id: old.run_id,
    coverage: "partial",
    pending_candidates: 0,
  });
  expect(reset.coverage).toBe("complete");
  expect(journal.sources()).toHaveLength(2);
  await census.producer.close();
  census = createHostedCollaborationCensus(nextOptions);
  await census.producer.step(journal);
  expect(census.store.status(project_id)).toEqual(reset);
});
