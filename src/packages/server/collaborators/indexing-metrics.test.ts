import {
  indexingOwnerFetches,
  indexingOwnerResponseBytes,
  measureOwnerProjectionFetch,
} from "./indexing-metrics";
import { createSharedProjectionFetcher } from "./projection-batch";
import type { CollaborationSharedProjectionPage } from "@cocalc/conat/inter-bay/collaborators";

beforeEach(() => {
  indexingOwnerFetches.reset();
  indexingOwnerResponseBytes.reset();
});

test("shared response bytes count once, not once per recipient", async () => {
  const jobs = ["a", "b"].map((account_id) => ({
    account_id,
    project_id: "p",
    generation: null,
    revision: 0,
    after_key: "",
  }));
  const response: CollaborationSharedProjectionPage = {
    catalog: null,
    recipients: jobs.map(({ account_id }) => ({ account_id, allowed: false })),
  };
  const run = createSharedProjectionFetcher(jobs, () =>
    measureOwnerProjectionFetch("shared", async () => response),
  );
  await Promise.all(jobs.map(run));
  expect((await indexingOwnerResponseBytes.get()).values).toEqual([
    expect.objectContaining({
      labels: { mode: "shared" },
      value: Buffer.byteLength(JSON.stringify(response)),
    }),
  ]);
  expect((await indexingOwnerFetches.get()).values).toEqual([
    expect.objectContaining({
      labels: { mode: "shared", outcome: "attempted" },
      value: 1,
    }),
    expect.objectContaining({
      labels: { mode: "shared", outcome: "received" },
      value: 1,
    }),
  ]);
});

test("failed fetch records no received bytes and preserves the error", async () => {
  const error = Error("unknown transport outcome");
  await expect(
    measureOwnerProjectionFetch("shared", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect((await indexingOwnerResponseBytes.get()).values).toEqual([]);
  expect((await indexingOwnerFetches.get()).values).toEqual([
    expect.objectContaining({
      labels: { mode: "shared", outcome: "attempted" },
      value: 1,
    }),
    expect.objectContaining({
      labels: { mode: "shared", outcome: "failed" },
      value: 1,
    }),
  ]);
});

test("individual responses count independently and measure UTF-8 payload bytes", async () => {
  const response = { title: "\u03bb" };
  expect(
    await measureOwnerProjectionFetch("individual", async () => response),
  ).toBe(response);
  await measureOwnerProjectionFetch("individual", async () => response);
  expect((await indexingOwnerResponseBytes.get()).values).toEqual([
    expect.objectContaining({
      labels: { mode: "individual" },
      value: 2 * Buffer.byteLength(JSON.stringify(response)),
    }),
  ]);
});
