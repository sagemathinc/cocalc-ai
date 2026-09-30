/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  createExamRunLocal,
  setExamConfigLocal,
  stopAndEraseExamRunLocal,
  type ExamHostRow,
} from "./exam";

const IMAGE = "cocalc.local/rootfs/exam";
let mockBeforeEncrypt: (() => Promise<void>) | undefined;
const mockControl = {
  listRootfsImages: jest.fn(),
  pullRootfsImage: jest.fn(),
  applyExamRun: jest.fn(),
  getExamRunStatus: jest.fn(),
  closeAndCleanupExamRun: jest.fn(),
};

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  ...jest.requireActual("@cocalc/database/settings/secret-settings"),
  encryptSecretStorageValue: async (_name: string, value: string) => {
    const hook = mockBeforeEncrypt;
    mockBeforeEncrypt = undefined;
    await hook?.();
    return `test-encrypted:${value}`;
  },
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

function runtime(run_id: string, status: string) {
  return { run_id, status, admission_open: false, active_projects: 0 };
}

async function configuredHost(): Promise<ExamHostRow> {
  const id = randomUUID();
  const host = {
    id,
    status: "running",
    public_url: `https://host-${id}.example.test`,
    metadata: { owner: account_id, cloudflare_tunnel: { id: "tunnel-1" } },
  };
  await setExamConfigLocal({
    host,
    actor_account_id: account_id,
    input: CONFIG,
  });
  return host;
}

function createRun(host: ExamHostRow) {
  return createExamRunLocal({
    host,
    actor_account_id: account_id,
    rootfs_image: IMAGE,
    cleanup_mode: "manual",
    idempotency_key: `create-${randomUUID()}`,
  });
}

async function runStatuses(host_id: string): Promise<string[]> {
  const { rows } = await getPool().query(
    "SELECT status FROM project_host_exam_runs WHERE host_id=$1",
    [host_id],
  );
  return rows.map(({ status }) => status);
}

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30000);

afterAll(async () => {
  await getPool().end();
});

beforeEach(() => {
  mockBeforeEncrypt = undefined;
  for (const fn of Object.values(mockControl)) fn.mockReset();
  mockControl.listRootfsImages.mockResolvedValue([
    { image: IMAGE, digest: "sha256:cached" },
  ]);
  mockControl.applyExamRun.mockImplementation(async ({ run }) =>
    runtime(run.run_id, "ready"),
  );
  mockControl.closeAndCleanupExamRun.mockImplementation(async ({ run_id }) =>
    runtime(run_id, "stopped"),
  );
});

describe("exam configuration saved during run preparation", () => {
  it("rejects a run whose configuration changed while its RootFS was cached", async () => {
    const host = await configuredHost();
    mockControl.listRootfsImages.mockImplementationOnce(async () => {
      await setExamConfigLocal({
        host,
        actor_account_id: account_id,
        input: { ...CONFIG, admission_token: "second-admission-token" },
      });
      return [{ image: IMAGE, digest: "sha256:cached" }];
    });

    await expect(createRun(host)).rejects.toThrow(
      "exam configuration changed while the run was being prepared",
    );
    expect(mockControl.applyExamRun).not.toHaveBeenCalled();
    expect(await runStatuses(host.id)).toEqual([]);
  });

  it("rejects a run whose admission token changed while its RootFS was cached", async () => {
    const host = await configuredHost();
    mockControl.listRootfsImages.mockImplementationOnce(async () => {
      await getPool().query(
        "UPDATE project_host_exam_configs SET token_ciphertext=$2 WHERE host_id=$1",
        [host.id, "test-encrypted:rotated-admission-token"],
      );
      return [{ image: IMAGE, digest: "sha256:cached" }];
    });

    await expect(createRun(host)).rejects.toThrow(
      "exam configuration changed while the run was being prepared",
    );
    expect(mockControl.applyExamRun).not.toHaveBeenCalled();
  });

  it("does not change the configuration once a run has been reserved", async () => {
    const host = await configuredHost();
    mockBeforeEncrypt = async () => {
      await createRun(host);
    };

    await expect(
      setExamConfigLocal({
        host,
        actor_account_id: account_id,
        input: { ...CONFIG, admission_token: "second-admission-token" },
      }),
    ).rejects.toThrow(
      "exam configuration cannot change while an exam run is active",
    );
    const { rows } = await getPool().query(
      "SELECT generation, token_ciphertext FROM project_host_exam_configs WHERE host_id=$1",
      [host.id],
    );
    expect(Number(rows[0].generation)).toBe(1);
    expect(rows[0].token_ciphertext).toBe(
      "test-encrypted:first-admission-token",
    );
  });
});

describe("exam run ended during preparation", () => {
  it("keeps the run stopped when the host reports an older preparation state", async () => {
    const host = await configuredHost();
    mockControl.applyExamRun.mockImplementationOnce(async ({ run }) => {
      await stopAndEraseExamRunLocal({
        host,
        run_id: run.run_id,
        poweroff: false,
      });
      return runtime(run.run_id, "cleaning");
    });

    const { run } = await createRun(host);
    expect(run.status).toBe("stopped");
    expect(await runStatuses(host.id)).toEqual(["stopped"]);
  });

  it("keeps the run stopped when preparation then fails", async () => {
    const host = await configuredHost();
    let run_id = "";
    mockControl.applyExamRun.mockImplementationOnce(async ({ run }) => {
      run_id = run.run_id;
      await stopAndEraseExamRunLocal({ host, run_id, poweroff: false });
      throw new Error("exam project readiness failed");
    });
    mockControl.getExamRunStatus.mockImplementationOnce(async () =>
      runtime(run_id, "cleaning"),
    );

    await expect(createRun(host)).rejects.toThrow(
      "exam project readiness failed",
    );
    expect(await runStatuses(host.id)).toEqual(["stopped"]);
  });
});
