/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  createExamRunLocal,
  getExamStateLocal,
  reconcileDueExamRunsOnce,
  setExamConfigLocal,
  type ExamHostRow,
} from "./exam";

const IMAGE = "cocalc.local/rootfs/exam";
const mockControl = {
  listRootfsImages: jest.fn(),
  pullRootfsImage: jest.fn(),
  applyExamRun: jest.fn(),
  getExamRunStatus: jest.fn(),
  closeAndCleanupExamRun: jest.fn(),
};
const mockAdminAlert = jest.fn();
const mockStopHostInternal = jest.fn();

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  ...jest.requireActual("@cocalc/database/settings/secret-settings"),
  encryptSecretStorageValue: async (_name: string, value: string) =>
    `test-encrypted:${value}`,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value: value.replace(/^test-encrypted:/, ""),
    needsMigration: false,
  }),
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  ensureHostnameCnameDns: async () => ({ record_id: "dns-record-1" }),
  ensureProxiedAddressDns: async () => ({ record_id: "dns-record-1" }),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: async () => mockControl,
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  stopHostInternal: (...args: any[]) => mockStopHostInternal(...args),
}));

const account_id = randomUUID();
const CONFIG = {
  enabled: true,
  max_projects: 10,
  project_cpu: 1,
  project_memory_mb: 2_000,
  project_disk_mb: 5_000,
  project_ttl_minutes: 6 * 60,
  cleanup_grace_minutes: 10,
  admission_token: "first-admission-token",
};

function runtime(run_id?: string, status?: string) {
  return {
    ...(run_id ? { run_id, status } : {}),
    admission_open: false,
    active_projects: 0,
  };
}

// The project host lists only its current run, so a run it has already
// erased is reported only when asked for by run_id.
function hostErased(run_id: string) {
  mockControl.getExamRunStatus.mockImplementation(async (opts) =>
    opts?.run_id === run_id ? runtime(run_id, "stopped") : runtime(),
  );
}

async function openRunPastDeadline({
  host_status = "running",
  stop_host_at_deadline = true,
}: {
  host_status?: string;
  stop_host_at_deadline?: boolean;
} = {}): Promise<{ host: ExamHostRow; run_id: string }> {
  const id = randomUUID();
  const host = {
    id,
    name: `exam-host-${id}`,
    status: "running",
    public_url: `https://host-${id}.example.test`,
    metadata: { owner: account_id, cloudflare_tunnel: { id: "tunnel-1" } },
  };
  await getPool().query(
    `INSERT INTO project_hosts (id, name, status, metadata, created, updated)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [id, host.name, host_status, host.metadata],
  );
  await setExamConfigLocal({
    host,
    actor_account_id: account_id,
    input: CONFIG,
  });
  const { run } = await createExamRunLocal({
    host,
    actor_account_id: account_id,
    rootfs_image: IMAGE,
    scheduled_stop_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    stop_host_at_deadline,
    idempotency_key: `create-${randomUUID()}`,
  });
  await getPool().query(
    "UPDATE project_host_exam_runs SET status='open' WHERE run_id=$1",
    [run.run_id],
  );
  await setDeadlineMinutesAgo(run.run_id, 1);
  return { host: { ...host, status: host_status }, run_id: run.run_id };
}

async function setDeadlineMinutesAgo(
  run_id: string,
  minutes: number,
): Promise<void> {
  await getPool().query(
    `UPDATE project_host_exam_runs
     SET scheduled_stop_at=NOW() - $2::INTEGER * INTERVAL '1 minute'
     WHERE run_id=$1`,
    [run_id, minutes],
  );
}

async function runRow(
  run_id: string,
): Promise<{ status: string; last_error: string | null }> {
  const { rows } = await getPool().query(
    "SELECT status, last_error FROM project_host_exam_runs WHERE run_id=$1",
    [run_id],
  );
  return rows[0];
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);

afterAll(async () => {
  await getPool().end();
});

beforeEach(() => {
  mockAdminAlert.mockReset();
  mockStopHostInternal.mockReset();
  for (const fn of Object.values(mockControl)) fn.mockReset();
  mockControl.listRootfsImages.mockResolvedValue([
    { image: IMAGE, digest: "sha256:cached" },
  ]);
  mockControl.applyExamRun.mockImplementation(async ({ run }) =>
    runtime(run.run_id, "ready"),
  );
  mockControl.getExamRunStatus.mockResolvedValue(runtime());
  mockControl.closeAndCleanupExamRun.mockImplementation(async ({ run_id }) =>
    runtime(run_id, "stopped"),
  );
});

afterEach(async () => {
  // The deadline loop scans every due run; keep each test's runs to itself.
  await getPool().query(
    "UPDATE project_host_exam_runs SET status='stopped' WHERE status <> 'stopped'",
  );
});

describe("exam status after the host erased the run at its deadline", () => {
  it("completes the hub run from the host's report for that run", async () => {
    const { host, run_id } = await openRunPastDeadline();
    hostErased(run_id);

    const state = await getExamStateLocal({ host, eligible: true });

    expect(state.run?.run_id).toBe(run_id);
    expect(state.run?.status).toBe("stopped");
    expect(state.run?.last_error).toBeNull();
  });
});

describe("scheduled exam cleanup when the host stops at the deadline", () => {
  it("waits for a host that has powered itself off without failing or alerting", async () => {
    const { run_id } = await openRunPastDeadline({ host_status: "off" });
    // A host that is off is waited for even after its own cleanup deadline.
    await setDeadlineMinutesAgo(run_id, CONFIG.cleanup_grace_minutes + 5);

    await reconcileDueExamRunsOnce();
    await reconcileDueExamRunsOnce();

    const run = await runRow(run_id);
    expect(run.status).toBe("closing");
    expect(run.last_error).toMatch(/waiting for the project host/);
    expect(mockAdminAlert).not.toHaveBeenCalled();
    expect(mockControl.closeAndCleanupExamRun).not.toHaveBeenCalled();
  });

  it("does not let runs waiting for stopped hosts crowd out newly due runs", async () => {
    // The deadline loop handles at most 16 due runs per pass.
    for (let i = 0; i < 16; i++) {
      await openRunPastDeadline({ host_status: "off" });
    }
    await reconcileDueExamRunsOnce();
    const { run_id } = await openRunPastDeadline({ host_status: "off" });

    await reconcileDueExamRunsOnce();

    expect((await runRow(run_id)).last_error).toMatch(
      /waiting for the project host/,
    );
  });

  it("waits for a host that still looks running but no longer answers, until its cleanup deadline", async () => {
    const { run_id } = await openRunPastDeadline();
    const unreachable = new Error("project host is not connected");
    mockControl.getExamRunStatus.mockRejectedValue(unreachable);
    mockControl.closeAndCleanupExamRun.mockRejectedValue(unreachable);

    await reconcileDueExamRunsOnce();

    let run = await runRow(run_id);
    expect(run.status).toBe("closing");
    expect(run.last_error).toMatch(/waiting for the project host/);
    expect(mockAdminAlert).not.toHaveBeenCalled();

    // The host powers itself off once its cleanup deadline (the exam
    // deadline plus the cleanup grace) passes, so a host that still looks
    // running after that is a failure.
    await setDeadlineMinutesAgo(run_id, CONFIG.cleanup_grace_minutes + 1);
    await reconcileDueExamRunsOnce();

    run = await runRow(run_id);
    expect(run.status).toBe("error");
    expect(run.last_error).toMatch(/project host is not connected/);
    expect(mockAdminAlert).toHaveBeenCalledTimes(1);
  });

  it("completes the run and stops the host again when it runs after the deadline", async () => {
    const { host, run_id } = await openRunPastDeadline({ host_status: "off" });
    await reconcileDueExamRunsOnce();
    // The owner starts the host again after the exam.
    await getPool().query(
      "UPDATE project_hosts SET status='running' WHERE id=$1",
      [host.id],
    );
    hostErased(run_id);

    await reconcileDueExamRunsOnce();

    expect(mockControl.closeAndCleanupExamRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id, poweroff: true }),
    );
    expect(mockStopHostInternal).toHaveBeenCalledWith({
      id: host.id,
      account_id,
    });
    const run = await runRow(run_id);
    expect(run.status).toBe("stopped");
    expect(run.last_error).toBeNull();
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("erases the projects and stops the host when the hub reaches the deadline first", async () => {
    const { host, run_id } = await openRunPastDeadline();
    mockControl.getExamRunStatus.mockImplementation(async () =>
      runtime(run_id, "open"),
    );

    await reconcileDueExamRunsOnce();

    expect(mockControl.closeAndCleanupExamRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id, poweroff: true }),
    );
    expect(mockStopHostInternal).toHaveBeenCalledWith({
      id: host.id,
      account_id,
    });
    expect((await runRow(run_id)).status).toBe("stopped");
  });

  it("cleans up a run on a running host that is meant to keep running as before", async () => {
    const { run_id } = await openRunPastDeadline({
      stop_host_at_deadline: false,
    });

    await reconcileDueExamRunsOnce();

    expect(mockControl.getExamRunStatus).not.toHaveBeenCalled();
    expect(mockControl.closeAndCleanupExamRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id, poweroff: false }),
    );
    expect(mockStopHostInternal).not.toHaveBeenCalled();
    expect((await runRow(run_id)).status).toBe("stopped");
  });

  it("still reports a failure when a host meant to keep running is off", async () => {
    const { run_id } = await openRunPastDeadline({
      host_status: "off",
      stop_host_at_deadline: false,
    });

    await reconcileDueExamRunsOnce();

    expect((await runRow(run_id)).status).toBe("error");
    expect(mockAdminAlert).toHaveBeenCalledTimes(1);
  });
});
