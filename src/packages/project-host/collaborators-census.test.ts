/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fd from "@cocalc/backend/sandbox/fd";
import { changedChatArchives } from "@cocalc/backend/chat-store/sqlite-offload";
jest.mock("@cocalc/backend/chat-store/sqlite-offload", () => ({
  changedChatArchives: jest.fn(() => []),
}));
import { CollaboratorsService } from "@cocalc/backend/collaborators/service";
import { randomUUID } from "node:crypto";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { censusPolicyFromEnvironment } from "@cocalc/backend/collaborators/census-policy";
import { getProject } from "./sqlite/projects";
import { getRecordedProjectVolumeIdentity } from "./sqlite/project-volumes";
import { createHostedCollaborationCensus } from "./collaborators-census";
import {
  invalidateProjectVolumeLifecycle,
  resetProjectVolumeLifecycleForTesting,
} from "./project-volume-lifecycle";
jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(),
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
  (changedChatArchives as jest.Mock).mockReturnValue([]);
  resetProjectVolumeLifecycleForTesting();
  (getProject as jest.Mock).mockReturnValue({ state: "stopped" });
  (getRecordedProjectVolumeIdentity as jest.Mock).mockReturnValue("volume-1");
});
afterEach(async () => {
  await census?.producer.close();
  census = undefined;
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function setup(now = Date.now) {
  const stream = {
    read: jest.fn().mockResolvedValue({
      name: "unknown.chat",
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    close: jest.fn(async () => {}),
    assertCurrent: jest.fn(async () => {}),
  };
  const fs = {
    fd: jest.fn(async () => {
      try {
        await stream.assertCurrent();
        const entry = await stream.read();
        return {
          stdout: entry ? `${entry.name}\0` : "",
          code: 0,
          truncated: false,
        };
      } finally {
        await stream.close();
      }
    }),
    close: jest.fn(),
    lstat: jest.fn(async () => ({ mtimeMs: Date.now() })),
    safeAbsPath: jest.fn(async (path) => path),
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
  };
  census = createHostedCollaborationCensus(options);
  return { options, fs, stream };
}
test("explicit mode leaves cold inventory untouched and only a requested run opens files", async () => {
  let now = 0;
  const { options } = setup(() => now);
  for (let day = 0; day < 3; day++) {
    now += 86400000;
    await census!.producer.step(journal);
  }
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

test("committed filename snapshot survives disable without repeating discovery", async () => {
  let now = 0;
  const { options, fs, stream } = setup(() => now);
  const entry = {
    name: "unknown.chat",
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  stream.read
    .mockReset()
    .mockImplementationOnce(async () => {
      now += 100; // End the bounded step after one durable observation.
      return entry;
    })
    .mockResolvedValue(null);
  const request = { project_id, run_id: randomUUID() };
  await census!.requestReconciliation(request);
  await census!.producer.step(journal);
  const checkpoint = census!.store.status(project_id)!;
  expect(checkpoint.traversal_complete).toBe(true);
  expect(journal.sources()).toHaveLength(1);

  options.enabled.mockResolvedValue(false);
  await census!.producer.pause();
  expect(stream.close).toHaveBeenCalledTimes(1);
  expect(fs.close).toHaveBeenCalledTimes(1);
  const reads = stream.read.mock.calls.length;
  for (let pass = 0; pass < 10; pass++) {
    await census!.producer.step(journal);
    await census!.producer.report!(journal);
  }
  expect(stream.read).toHaveBeenCalledTimes(reads);
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
  expect(options.report).not.toHaveBeenCalled();
  expect(census!.store.status(project_id)).toEqual(checkpoint);
  await expect(
    census!.requestReconciliation({ project_id, run_id: randomUUID() }),
  ).rejects.toMatchObject({ code: "DISABLED" });

  // Reopening a real directory starts from the beginning. Replay must not
  // duplicate the already committed source or allocate a new Scan identity.
  stream.read.mockReset().mockResolvedValueOnce(entry).mockResolvedValue(null);
  options.enabled.mockResolvedValue(true);
  await census!.producer.step(journal);
  expect(census!.store.status(project_id)).toMatchObject({
    run: { run_id: request.run_id },
    traversal_complete: true,
  });
  expect(journal.sources()).toHaveLength(1);
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
  for (let pass = 0; pass < 10; pass++) await census!.producer.step(journal);
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
});

test("explicit requests recheck disabled, owner denial, missing volume, and replacement fences", async () => {
  const { options } = setup(() => 0);
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

test("explicit reconciliation reports changed progress rather than periodic heartbeats", async () => {
  let now = 0;
  const { options } = setup(() => now);
  await census!.requestReconciliation({ project_id, run_id: randomUUID() });
  await census!.producer.step(journal);
  await census!.producer.report!(journal);
  expect(options.report).toHaveBeenCalledTimes(1);
  now = 86400000;
  await census!.producer.step(journal);
  await census!.producer.report!(journal);
  expect(options.report).toHaveBeenCalledTimes(1);
  expect(options.getFilesystem).toHaveBeenCalledTimes(1);
  journal.touch({ project_id, chat_path: "/home/user/new.chat" });
  await census!.producer.report!(journal);
  expect(options.report).toHaveBeenCalledTimes(1);
  journal.defer(
    journal
      .registrations()
      .find((s) => s.chat_path === "/home/user/unknown.chat")!,
    now,
  );
  await census!.producer.report!(journal);
  expect(options.report).toHaveBeenCalledTimes(2);
});

test("explicit status is authorized, inert, and distinguishes discovery from ingestion", async () => {
  const { options } = setup(() => 0);
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
  await census!.requestReconciliation({ project_id, run_id: randomUUID() });
  expect(options.getFilesystem).not.toHaveBeenCalled();
  await census!.producer.step(journal);
  expect(fs.fd).toHaveBeenCalledWith(
    "/home/user",
    expect.objectContaining({
      pattern: "\\.chat$",
      options: expect.arrayContaining([
        "--hidden",
        "--no-ignore",
        "--one-file-system",
        ".snapshots",
        "--print0",
      ]),
    }),
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
  await expect(
    census!.requestReconciliation({ project_id, run_id: randomUUID() }),
  ).rejects.toMatchObject({ code: "ENODEV" });
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
  expect(census!.store.status(project_id)).toBeUndefined();
});
test("owner denial and volume replacement fence candidate handoff", async () => {
  const { options, stream } = setup();
  await census!.requestReconciliation({ project_id, run_id: randomUUID() });
  options.authorize.mockRejectedValueOnce(Error("wrong current host"));
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
  const run = census!.store.status(project_id)!.run;
  // Simulates an already retained candidate before host reassignment.
  census!.store.recordDiscovery(run, [run.root + "/retained.chat"]);
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
  await census!.requestReconciliation({ project_id, run_id: randomUUID() });
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
  options.enabled.mockResolvedValue(true);
  (getProject as jest.Mock).mockReturnValue({ exam_run_id: randomUUID() });
  await expect(
    census!.requestReconciliation({ project_id, run_id: randomUUID() }),
  ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  await census!.producer.step(journal);
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(census!.store.status(project_id)).toBeUndefined();
});

test("policy changes preserve admitted work until an explicit replacement", async () => {
  let now = 0;
  const { options } = setup(() => now);
  const request = { project_id, run_id: randomUUID() };
  await census!.requestReconciliation(request);
  const old = census!.store.status(project_id)!.run;
  census!.store.recordDiscovery(old, [old.root + "/retained.chat"]);
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
  now += 3600000;
  await census.producer.step(journal);
  expect(census.store.status(project_id)?.run.run_id).toBe(old.run_id);
  const next = {
    project_id,
    run_id: randomUUID(),
    expected_run_id: old.run_id,
  };
  expect(await census.requestReconciliation(next)).toMatchObject({
    admission: "accepted",
  });
  await census.producer.step(journal);
  const reset = census.store.status(project_id)!;
  expect(reset.run.run_id).toBe(next.run_id);
  expect(reset.run.policy_version).toBe(nextOptions.policy.version);
  expect(reset.coverage).toBe("complete");
  expect(journal.sources()).toHaveLength(2);
  await census.producer.close();
  census = createHostedCollaborationCensus(nextOptions);
  await census.producer.step(journal);
  expect(census.store.status(project_id)).toEqual(reset);
});

test("cancellation fences a delayed request and survives host restart while disabled", async () => {
  const { options } = setup(Date.now);
  const request = { project_id, run_id: randomUUID() };
  await census!.cancelReconciliation(request);
  await expect(census!.requestReconciliation(request)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await census!.producer.close();
  census = createHostedCollaborationCensus(options);
  options.enabled.mockResolvedValue(false);
  expect(await census.reconciliationStatus(request)).toEqual({
    state: "cancelled",
    run_id: request.run_id,
  });
  await census.cancelReconciliation(request);
  expect(options.getFilesystem).not.toHaveBeenCalled();
});

test("cancel during an awaited directory read fences commits and releases handles", async () => {
  const { options, stream } = setup(Date.now);
  const request = { project_id, run_id: randomUUID() };
  await census!.requestReconciliation(request);
  let resolveRead!: (value: any) => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  stream.read.mockImplementationOnce(() => {
    reading();
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  });
  const traversal = census!.producer.step(journal);
  await started;
  let acknowledged = false;
  const cancelled = census!.cancelReconciliation(request).then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  resolveRead({
    name: "late.chat",
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  });
  await traversal;
  await cancelled;
  expect(stream.close).toHaveBeenCalled();
  expect(census!.store.status(project_id)?.candidates).toBe(0);
  await census!.producer.step(journal);
  await census!.producer.report!(journal);
  expect(options.report).not.toHaveBeenCalled();
  expect(journal.sources()).toEqual([]);
});

test("cancel waits for a report already sent before acknowledging", async () => {
  const { options } = setup(Date.now);
  const request = { project_id, run_id: randomUUID() };
  await census!.requestReconciliation(request);
  await census!.producer.step(journal);
  let finish!: () => void;
  let sending!: () => void;
  const started = new Promise<void>((resolve) => {
    sending = resolve;
  });
  options.report.mockImplementationOnce(() => {
    sending();
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const reporting = census!.producer.report!(journal);
  await started;
  let stopped = false;
  const cancellation = census!.cancelReconciliation(request).then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await reporting;
  await cancellation;
  expect(stopped).toBe(true);
  await census!.producer.report!(journal);
  expect(options.report).toHaveBeenCalledTimes(1);
});

test("fd finds hidden and ignored chats, preserves newline names, and excludes snapshots and links", async () => {
  const { options, fs } = setup();
  const root = join(directory, "home");
  for (const sub of [
    ".hidden",
    ".snapshots",
    "nested/.snapshots",
    ".trash",
    "ignored",
  ])
    mkdirSync(join(root, sub), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  for (const path of [
    "a.chat",
    ".hidden/b.chat",
    "ignored/c.chat",
    "old.sage-chat",
    ".trash/d.chat",
    "newline\nname.chat",
    ".snapshots/old.chat",
    "nested/.snapshots/old.chat",
    "irrelevant.txt",
  ])
    writeFileSync(join(root, path), "");
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "linked.chat"), "");
  symlinkSync(outside, join(root, "linked-directory"));
  symlinkSync(join(outside, "linked.chat"), join(root, "linked.chat"));
  fs.fd.mockImplementation((_path, opts: any) => fd(root, opts) as any);
  await census!.requestReconciliation({ project_id, run_id: randomUUID() });
  await census!.producer.step(journal);
  expect(options.onError).not.toHaveBeenCalled();
  expect(
    journal
      .sources()
      .map((s) => s.chat_path)
      .sort(),
  ).toEqual(
    [
      "/home/user/a.chat",
      "/home/user/.hidden/b.chat",
      "/home/user/ignored/c.chat",
      "/home/user/.trash/d.chat",
      "/home/user/newline\nname.chat",
    ].sort(),
  );
  expect(fs.fd).toHaveBeenCalledTimes(1);
});

test.each([
  { stdout: "a.chat\0", code: 0, truncated: true },
  { stdout: "a.chat\0", code: 1, truncated: false },
  { stdout: "../escape.chat\0", code: 0, truncated: false },
  { stdout: ".snapshots/old.chat\0", code: 0, truncated: false },
])(
  "incomplete or out-of-scope search never commits a complete snapshot: %j",
  async (result) => {
    const { fs } = setup();
    fs.fd.mockResolvedValue(result as any);
    await census!.requestReconciliation({ project_id, run_id: randomUUID() });
    await census!.producer.step(journal);
    expect(journal.sources()).toEqual([]);
    expect(census!.store.status(project_id)?.traversal_complete).toBe(false);
  },
);

test("actual service timer indexes 19 chats among 100 tiny directories promptly", async () => {
  const { options, fs } = setup();
  const root = join(directory, "home");
  mkdirSync(root);
  for (let i = 0; i < 100; i++) {
    mkdirSync(join(root, `dir-${i}`));
    writeFileSync(
      join(root, `dir-${i}`, i < 19 ? "a.chat" : "other.txt"),
      "{}",
    );
  }
  fs.fd.mockImplementation((_path, opts: any) => fd(root, opts) as any);
  const sends = jest.fn(async () => ({ revision: 1, replayed: false }));
  const worker = new CollaboratorsService({
    filename: join(directory, "timed-journal.sqlite"),
    census: census!.producer,
    enabled: async () => true,
    discover: async () => [],
    writerState: async () => null,
    register: async () => ({ epoch: "epoch" }),
    read: async () => ({ resources: [], activity_ids: {} }),
    send: sends,
    onError: options.onError,
  });
  try {
    await census!.requestReconciliation({ project_id, run_id: randomUUID() });
    const start = performance.now();
    worker.start();
    while (
      options.report.mock.calls.at(-1)?.[0]?.report.coverage !== "complete" &&
      performance.now() - start < 5000
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(options.onError).not.toHaveBeenCalled();
    expect(sends).toHaveBeenCalledTimes(19);
    expect(options.report.mock.calls.at(-1)?.[0]?.report).toMatchObject({
      coverage: "complete",
      source_pending: 0,
      candidates: 19,
    });
    expect(performance.now() - start).toBeLessThan(5000);
    expect(fs.fd).toHaveBeenCalledTimes(1);
  } finally {
    await worker.close();
    census = undefined;
  }
}, 10000);

test("host completion waits for source indexing, not only filename handoff", async () => {
  const { options } = setup();
  const progress = { source_pending: 1, source_errors: 0 };
  await census!.producer.close();
  census = createHostedCollaborationCensus({
    ...options,
    sourceProgress: () => progress,
  });
  const request = { project_id, run_id: randomUUID() };
  await census.requestReconciliation(request);
  await census.producer.step(journal);
  expect(await census.reconciliationStatus(request)).toMatchObject({
    state: "indexing",
    pending_candidates: 0,
    source_pending: 1,
  });
  progress.source_pending = 0;
  expect(await census.reconciliationStatus(request)).toMatchObject({
    state: "discovered",
    source_pending: 0,
  });
  progress.source_errors = 1;
  expect(await census.reconciliationStatus(request)).toMatchObject({
    state: "partial",
    source_errors: 1,
  });
});

test("project watermark skips unchanged files, includes edits during the scan and changed archives, and survives restart", async () => {
  let now = 1000;
  const { options, fs } = setup(() => now);
  const progress = {
    source_pending: 1,
    source_errors: 1,
    source_file_errors: 1,
  };
  await census!.producer.close();
  census = createHostedCollaborationCensus({
    ...options,
    sourceProgress: () => progress,
  });
  const first = { project_id, run_id: randomUUID() };
  await census.requestReconciliation(first);
  await census.producer.step(journal);
  expect(await census.reconciliationStatus(first)).toMatchObject({
    last_success: 1000,
  });
  await census.producer.close();
  census = createHostedCollaborationCensus({
    ...options,
    sourceProgress: () => progress,
  });
  expect(census.store.scanTimes(project_id)).toEqual({ last_success: 1000 });
  now += 300000;
  const next = {
    project_id,
    run_id: randomUUID(),
    expected_run_id: first.run_id,
  };
  await census.requestReconciliation(next);
  fs.fd.mockResolvedValueOnce({
    stdout: "old.chat\0during.chat\0archive.chat\0",
    code: 0,
    truncated: false,
  });
  fs.lstat.mockImplementation(async (path) => ({
    mtimeMs: path.endsWith("during.chat") ? 1000 : 999,
  }));
  (changedChatArchives as jest.Mock).mockReturnValue([
    "/home/user/archive.chat",
  ]);
  progress.source_pending =
    progress.source_errors =
    progress.source_file_errors =
      0;
  await census.producer.step(journal);
  expect(journal.sources().map((s) => s.chat_path)).toEqual([
    "/home/user/archive.chat",
    "/home/user/during.chat",
    "/home/user/unknown.chat",
  ]);
  expect(census.store.status(project_id)?.candidates).toBe(2);
  expect(await census.reconciliationStatus(next)).toMatchObject({
    last_success: 301000,
  });
  expect(changedChatArchives).toHaveBeenCalledWith(
    expect.objectContaining({ since: 1000 }),
  );
});

test("service failure and cancellation preserve the last successful start-time watermark", async () => {
  let now = 1000;
  const { options } = setup(() => now);
  const progress = { source_pending: 0, source_errors: 0 };
  await census!.producer.close();
  census = createHostedCollaborationCensus({
    ...options,
    sourceProgress: () => progress,
  });
  const first = { project_id, run_id: randomUUID() };
  await census.requestReconciliation(first);
  await census.producer.step(journal);
  expect(await census.reconciliationStatus(first)).toMatchObject({
    last_success: 1000,
  });
  now += 300000;
  const failed = {
    project_id,
    run_id: randomUUID(),
    expected_run_id: first.run_id,
  };
  await census.requestReconciliation(failed);
  await census.producer.step(journal);
  progress.source_pending = progress.source_errors = 1;
  expect(await census.reconciliationStatus(failed)).toMatchObject({
    last_success: 1000,
    last_fail: 301000,
  });
  now += 300000;
  const cancelled = {
    project_id,
    run_id: randomUUID(),
    expected_run_id: failed.run_id,
  };
  await census.requestReconciliation(cancelled);
  await census.cancelReconciliation(cancelled);
  expect(census.store.scanTimes(project_id)).toEqual({
    last_success: 1000,
    last_fail: 601000,
  });
});
