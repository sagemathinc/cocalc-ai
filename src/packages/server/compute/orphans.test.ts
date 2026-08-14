/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));

import {
  computeOrphanId,
  observeComputeOrphan,
  resolveAbsentComputeOrphans,
} from "./orphans";

beforeEach(() => query.mockReset());

it("uses provider, resource type, and opaque ID for stable identity", () => {
  const base = {
    provider: "nebius" as const,
    resource_type: "instance" as const,
    resource_id: "instance-opaque-id",
  };
  expect(computeOrphanId(base)).toMatch(/^[a-f0-9]{64}$/);
  expect(computeOrphanId(base)).toBe(computeOrphanId(base));
  expect(computeOrphanId(base)).not.toBe(
    computeOrphanId({ ...base, resource_type: "address" }),
  );
});

it("records a durable grace period and increments repeated observations", async () => {
  query.mockResolvedValueOnce({
    rows: [
      {
        id: "a".repeat(64),
        provider: "gcp",
        resource_type: "instance",
        resource_id: "vm-1",
        state: "observed",
        observation_count: 2,
        metadata: {},
      },
    ],
  });
  await observeComputeOrphan(
    {
      provider: "gcp",
      resource_type: "instance",
      resource_id: "vm-1",
      zone: "us-west1-a",
    },
    86_400_000,
  );
  expect(query.mock.calls[0][0]).toContain(
    "observation_count=compute_vm_orphans.observation_count+1",
  );
  expect(query.mock.calls[0][1][7]).toBe(86_400_000);
});

it("resolves absent resources only within the observed resource classes", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await resolveAbsentComputeOrphans(["still-present"], ["instance", "address"]);
  expect(query.mock.calls[0][0]).toContain("resource_type = ANY($2::text[])");
  expect(query.mock.calls[0][1]).toEqual([
    ["still-present"],
    ["instance", "address"],
  ]);
});
