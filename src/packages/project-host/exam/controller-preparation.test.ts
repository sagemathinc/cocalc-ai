/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  applyExamRunLocal,
  closeAndCleanupExamRunLocal,
  getExamRunStatusLocal,
} from "./controller";
import { verifyExamPublicRoute } from "./public-route";

const IMAGE = "cocalc.local/rootfs/exam";
const DIGEST = "sha256:cached";

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
}));

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: { projects: { createProject: async () => {}, stop: async () => {} } },
}));

jest.mock("@cocalc/project-runner/run/sandbox-exec", () => ({
  sandboxExec: async ({ script }: { script: string }) => ({
    code: 0,
    stdout: script.match(/cocalc-exam-smoke-[0-9a-f-]+/)?.[0] ?? "",
    stderr: "",
  }),
}));

jest.mock("../file-server", () => ({
  deleteVolume: async () => {},
  getVolume: async () => {
    throw new Error("project volume does not exist");
  },
}));

jest.mock("../rootfs-cache", () => ({
  listRootfsCacheEntries: async () => [{ image: IMAGE, digest: DIGEST }],
}));

jest.mock("../sqlite/projects", () => ({
  deleteProjectLocal: () => {},
  getProject: () => undefined,
  upsertProject: () => {},
}));

jest.mock("./network-policy", () => ({
  setExamProjectNetworkPolicy: async () => {},
  verifyExamProjectNetworkPolicy: async () => {},
}));

jest.mock("./public-route", () => ({
  verifyExamPublicRoute: jest.fn(async () => {}),
}));

function examRequest() {
  const host_id = randomUUID();
  const account_id = randomUUID();
  const now = new Date().toISOString();
  const config = {
    host_id,
    enabled: true,
    title: "Exam Scratchpad",
    hostname: "exam-1.example.test",
    dns_record_id: null,
    dns_target: null,
    generation: 1,
    max_projects: 10,
    project_cpu: 1,
    project_memory_mb: 2_000,
    project_disk_mb: 5_000,
    project_ttl_minutes: 360,
    cleanup_grace_minutes: 10,
    terminal_enabled: false,
    network_mode: "disabled" as const,
    created_at: now,
    updated_at: now,
    created_by: account_id,
    updated_by: account_id,
  };
  const run = {
    run_id: randomUUID(),
    host_id,
    config_generation: 1,
    status: "preparing" as const,
    rootfs_image: IMAGE,
    rootfs_digest: DIGEST,
    run_quota: {
      cpu_limit: 1,
      memory_limit: 2_000,
      disk_quota: 5_000,
      pids_limit: 4_096,
    },
    max_projects: 10,
    terminal_enabled: false,
    network_mode: "disabled" as const,
    cleanup_mode: "manual" as const,
    scheduled_stop_at: "9999-12-31T23:59:59.000Z",
    stop_host_at_deadline: false,
    owner_account_id: account_id,
    opened_at: null,
    admission_closed_at: null,
    cleanup_started_at: null,
    cleaned_at: null,
    stopped_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    created_by: account_id,
  };
  return { config, run, token_hash: "scrypt-v1$salt$digest" };
}

describe("project-host exam run preparation", () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env, COCALC_LITE_SQLITE_FILENAME: ":memory:" };
    closeDatabase();
    jest.mocked(verifyExamPublicRoute).mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = env;
  });

  it("marks a prepared run ready", async () => {
    const request = examRequest();
    const status = await applyExamRunLocal(request);
    expect(status).toMatchObject({
      run_id: request.run.run_id,
      status: "ready",
    });
  });

  it("does not revive a run that was ended while it was being prepared", async () => {
    const request = examRequest();
    jest.mocked(verifyExamPublicRoute).mockImplementationOnce(async () => {
      await closeAndCleanupExamRunLocal({
        run_id: request.run.run_id,
        config_generation: 1,
      });
    });

    const status = await applyExamRunLocal(request);
    expect(status.status).toBe("stopped");
    expect(getExamRunStatusLocal().run_id).toBeUndefined();
  });

  it("does not mark an ended run as failed when preparation then fails", async () => {
    const request = examRequest();
    jest.mocked(verifyExamPublicRoute).mockImplementationOnce(async () => {
      await closeAndCleanupExamRunLocal({
        run_id: request.run.run_id,
        config_generation: 1,
      });
      throw new Error("exam public route is not reachable");
    });

    await expect(applyExamRunLocal(request)).rejects.toThrow(
      "exam public route is not reachable",
    );
    expect(getExamRunStatusLocal({ run_id: request.run.run_id }).status).toBe(
      "stopped",
    );
    expect(getExamRunStatusLocal().run_id).toBeUndefined();
  });
});
