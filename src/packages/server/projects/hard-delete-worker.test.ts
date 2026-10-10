/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { LroSummary } from "@cocalc/conat/hub/api/lro";

const mockClaimLroOps = jest.fn();
const mockHardDeleteProject = jest.fn();
const mockProcessDueDeletedProjectBackupPurges = jest.fn();
const mockUpdateLro = jest.fn();

jest.mock("@cocalc/server/hosts/maintenance", () => ({
  assertProjectHostsNotUnderMaintenance: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/lro/stream", () => ({
  publishLroEvent: jest.fn(async () => undefined),
  publishLroSummary: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/lro/worker-config", () => ({
  getEffectiveParallelOpsLimit: jest.fn(async () => ({ value: 20 })),
}));
jest.mock("@cocalc/server/lro/lro-db", () => ({
  claimLroOps: (...args: unknown[]) => mockClaimLroOps(...args),
  touchLro: jest.fn(async () => undefined),
  updateLro: (...args: unknown[]) => mockUpdateLro(...args),
}));
jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "test-bay"),
}));
jest.mock("@cocalc/server/projects/hard-delete", () => ({
  hardDeleteProject: (...args: unknown[]) => mockHardDeleteProject(...args),
  processDueDeletedProjectBackupPurges: (...args: unknown[]) =>
    mockProcessDueDeletedProjectBackupPurges(...args),
}));
jest.mock("@cocalc/server/projects/hard-delete-state", () => ({
  markProjectHardDeleteFailed: jest.fn(async () => false),
}));

import {
  startProjectHardDeleteWorker,
  triggerProjectHardDeleteWorker,
} from "./hard-delete-worker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

async function waitFor(check: () => void): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      check();
      return;
    } catch (err) {
      if (i === 19) throw err;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

const op = {
  op_id: "00000000-0000-4000-8000-000000000001",
  scope_type: "project",
  scope_id: "00000000-0000-4000-8000-000000000002",
  created_by: "00000000-0000-4000-8000-000000000003",
  input: {
    project_id: "00000000-0000-4000-8000-000000000002",
  },
} as LroSummary;

beforeEach(() => {
  mockClaimLroOps.mockReset();
  mockHardDeleteProject.mockReset();
  mockProcessDueDeletedProjectBackupPurges.mockReset();
  mockUpdateLro.mockReset();
  mockUpdateLro.mockImplementation(async (change) => ({ ...op, ...change }));
  mockProcessDueDeletedProjectBackupPurges.mockResolvedValue({
    processed: 0,
    purged: 0,
    failed: 0,
  });
});

it("clamps hard-delete concurrency and does not overlap backup purges", async () => {
  const deletion = deferred<Record<string, unknown>>();
  mockClaimLroOps.mockResolvedValueOnce([op]).mockResolvedValue([]);
  mockHardDeleteProject.mockReturnValue(deletion.promise);

  const stop = startProjectHardDeleteWorker({ intervalMs: 60_000 });
  await waitFor(() => expect(mockHardDeleteProject).toHaveBeenCalledTimes(1));

  expect(mockClaimLroOps).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 1 }),
  );
  expect(mockProcessDueDeletedProjectBackupPurges).not.toHaveBeenCalled();

  triggerProjectHardDeleteWorker();
  triggerProjectHardDeleteWorker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockHardDeleteProject).toHaveBeenCalledTimes(1);
  expect(mockProcessDueDeletedProjectBackupPurges).not.toHaveBeenCalled();

  deletion.resolve({ project_id: op.scope_id });
  await waitFor(() =>
    expect(mockUpdateLro).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    ),
  );
  triggerProjectHardDeleteWorker();
  await waitFor(() =>
    expect(mockProcessDueDeletedProjectBackupPurges).toHaveBeenCalledWith({
      limit: 1,
    }),
  );
  stop();
});

it("coalesces ticks while a deferred backup purge is running", async () => {
  const purge = deferred<{
    processed: number;
    purged: number;
    failed: number;
  }>();
  mockClaimLroOps.mockResolvedValue([]);
  mockProcessDueDeletedProjectBackupPurges.mockReturnValue(purge.promise);

  const stop = startProjectHardDeleteWorker({
    intervalMs: 60_000,
    maxParallel: 1,
  });
  await waitFor(() =>
    expect(mockProcessDueDeletedProjectBackupPurges).toHaveBeenCalledTimes(1),
  );

  triggerProjectHardDeleteWorker();
  triggerProjectHardDeleteWorker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockProcessDueDeletedProjectBackupPurges).toHaveBeenCalledTimes(1);

  stop();
  purge.resolve({ processed: 0, purged: 0, failed: 0 });
});
