/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createLro } from "@cocalc/server/lro/lro-db";
import { _test } from "./availability";

jest.mock("@cocalc/server/lro/lro-db", () => ({
  createLro: jest.fn(async () => ({ op_id: "op-1" })),
  ensureLroSchema: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: async () => ({ rows: [] }) }),
}));

describe("stale-running host repair", () => {
  it("queues the site's own repair, which names no software source", async () => {
    await expect(
      _test.enqueueRunningStaleHostRepairs([
        {
          id: "host-1",
          status: "running",
          metadata: { owner: "owner-account" },
          stale_ms: 20 * 60_000,
        } as any,
      ]),
    ).resolves.toBe(1);
    const queued = jest.mocked(createLro).mock.calls[0][0] as any;
    expect(queued).toMatchObject({
      kind: "host-reconcile-software",
      created_by: "owner-account",
      input: { id: "host-1", automatic: true },
    });
    expect(queued.input.base_url).toBeUndefined();
  });
});
