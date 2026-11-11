/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { startHostLroWorker } from "./start-worker";
import * as lroDb from "../lro/lro-db";
import * as hosts from "../conat/api/hosts";
import getPool from "@cocalc/database/pool";
import * as stream from "../lro/stream";

jest.mock("../lro/lro-db", () => ({
  claimLroOps: jest.fn(),
  createLro: jest.fn(),
  getLro: jest.fn(),
  touchLro: jest.fn(),
  updateLro: jest.fn(),
}));
jest.mock("../conat/api/hosts", () => ({
  hostSoftwareLifecycleOpRefusal: jest.fn(),
  upgradeHostSoftwareInternal: jest.fn(),
  rolloutHostManagedComponentsInternal: jest.fn(),
  reconcileHostSoftwareInternal: jest.fn(),
  reconcileHostRuntimeDeploymentsInternal: jest.fn(),
  rollbackHostRuntimeDeploymentsInternal: jest.fn(),
}));
jest.mock("../lro/stream", () => ({
  publishLroSummary: jest.fn(),
  publishLroEvent: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const REFUSAL = "host software maintenance is limited to site admins";

describe("host software operations queued before they became admin-only", () => {
  test.each([
    "host-upgrade-software",
    "host-reconcile-software",
    "host-rollout-managed-components",
    "host-reconcile-runtime-deployments",
    "host-rollback-runtime-deployments",
  ])("a queued %s that is refused fails without running", async (kind) => {
    jest.clearAllMocks();
    const input = {
      id: "test-host",
      account_id: "owner-account",
      targets: [{ artifact: "project-host", version: "v2" }],
      base_url: "https://software.example.test/software",
    };
    let summary: any = {
      op_id: "test-op",
      kind,
      scope_type: "host",
      scope_id: "test-host",
      created_by: "owner-account",
      status: "queued",
      input,
    };
    let claimed = false;
    jest.mocked(lroDb.claimLroOps).mockImplementation(async (opts) => {
      if (opts.kind !== kind || claimed) return [];
      claimed = true;
      return [summary];
    });
    jest.mocked(lroDb.getLro).mockImplementation(async () => summary);
    jest.mocked(lroDb.touchLro).mockResolvedValue(undefined as any);
    jest.mocked(stream.publishLroSummary).mockResolvedValue(undefined as any);
    jest.mocked(stream.publishLroEvent).mockResolvedValue(undefined as any);
    jest
      .mocked(hosts.hostSoftwareLifecycleOpRefusal)
      .mockResolvedValue(REFUSAL);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    jest.mocked(lroDb.updateLro).mockImplementation(async (update) => {
      summary = { ...summary, ...update };
      if (summary.status === "failed" || summary.status === "succeeded") {
        finish();
      }
      return summary;
    });
    const query = jest.fn(async () => ({ rows: [] }));
    jest.mocked(getPool).mockReturnValue({ query } as any);
    const stop = startHostLroWorker({ maxParallel: 1, intervalMs: 1_000_000 });
    try {
      await finished;
      await new Promise((resolve) => setImmediate(resolve));
      expect(hosts.hostSoftwareLifecycleOpRefusal).toHaveBeenCalledWith({
        kind,
        account_id: "owner-account",
        input,
      });
      expect(summary.status).toBe("failed");
      expect(summary.error).toBe(REFUSAL);
      expect(jest.mocked(lroDb.updateLro).mock.calls).toEqual([
        [{ op_id: "test-op", status: "failed", error: REFUSAL }],
      ]);
      for (const run of [
        hosts.upgradeHostSoftwareInternal,
        hosts.rolloutHostManagedComponentsInternal,
        hosts.reconcileHostSoftwareInternal,
        hosts.reconcileHostRuntimeDeploymentsInternal,
        hosts.rollbackHostRuntimeDeploymentsInternal,
      ]) {
        expect(run).not.toHaveBeenCalled();
      }
      expect(query).not.toHaveBeenCalled();
      expect(lroDb.touchLro).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
