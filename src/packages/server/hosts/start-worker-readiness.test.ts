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
  startHostInternal: jest.fn(),
  restartHostInternal: jest.fn(),
}));
jest.mock("../lro/stream", () => ({
  publishLroSummary: jest.fn(),
  publishLroEvent: jest.fn(),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe("host readiness worker result persistence", () => {
  test.each([
    ["gcp", "host-restart", false, false],
    ["lambda", "host-start", false, false],
    ["gcp", "host-restart", true, false],
    ["gcp", "host-restart", false, true],
  ] as const)(
    "%s %s failure=%s baseline=%s",
    async (provider, kind, failure, baseline) => {
      jest.clearAllMocks();
      const now = Date.now();
      let summary: any = {
        op_id: "test-op",
        kind,
        scope_type: "host",
        scope_id: "test-host",
        created_by: "test-account",
        status: "queued",
      };
      let host: any = {
        status: "error",
        last_seen: null,
        metadata: {
          machine: { cloud: provider },
          runtime: { instance_id: "existing-vm" },
          ...(baseline ? { host_boot_id: "old-boot" } : {}),
          bootstrap: {
            status: "error",
            updated_at: new Date(now - 60_000).toISOString(),
            message: "old toolkit failure",
          },
        },
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
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      jest.mocked(lroDb.updateLro).mockImplementation(async (update) => {
        summary = { ...summary, ...update };
        if (
          update.progress_summary?.phase === "readiness-unverified" &&
          update.progress_summary?.provider_request_acknowledged === true
        ) {
          finish();
        }
        if (
          update.progress_summary?.phase === "done" &&
          ["failed", "succeeded"].includes(summary.status)
        )
          finish();
        return summary;
      });
      const dispatch = jest.fn(async (opts: any) => {
        opts.onWorkQueued("exact-work-id");
        host = {
          ...host,
          status: "running",
          last_seen: new Date(now + 10),
          metadata: { ...host.metadata, host_boot_id: "new-boot" },
        };
        return {} as any;
      });
      jest.mocked(hosts.startHostInternal).mockImplementation(dispatch);
      jest.mocked(hosts.restartHostInternal).mockImplementation(dispatch);
      const query = jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes("FROM project_hosts")) return { rows: [host] };
        if (sql.includes("FROM cloud_vm_work")) {
          expect(params).toEqual([
            "exact-work-id",
            "test-host",
            kind === "host-start" ? "start" : "restart",
          ]);
          return {
            rows: [
              {
                state: failure ? "failed" : "done",
                error: failure ? "provider rejected request" : null,
                updated_at: new Date(now + 1),
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      jest.mocked(getPool).mockReturnValue({ query } as any);
      const stop = startHostLroWorker({
        maxParallel: 1,
        intervalMs: 1_000_000,
      });
      try {
        await finished;
        await new Promise((resolve) => setImmediate(resolve));
        expect(dispatch).toHaveBeenCalledTimes(1);
        if (failure) {
          expect(summary.status).toBe("failed");
          expect(summary.error).toContain("provider rejected request");
          expect(summary.result).toBeUndefined();
        } else if (baseline) {
          expect(summary.status).toBe("succeeded");
          expect(summary.result).toEqual({
            host_id: "test-host",
            status: "running",
          });
        } else {
          expect(summary.status).toBe("failed");
          expect(summary.error).toContain("request was sent");
          expect(summary.result).toMatchObject({
            host_id: "test-host",
            cloud_work_id: "exact-work-id",
            provider_request_acknowledged: true,
            readiness: "unverified",
            reason: "missing_pre_operation_identity",
          });
          expect(summary.progress_summary.phase).toBe("readiness-unverified");
        }
        expect(stream.publishLroSummary).toHaveBeenCalledWith(
          expect.objectContaining({
            summary: expect.objectContaining({ status: summary.status }),
          }),
        );
        expect(
          query.mock.calls.every(([sql]) =>
            sql.trimStart().startsWith("SELECT"),
          ),
        ).toBe(true);
      } finally {
        stop();
      }
    },
  );
});
