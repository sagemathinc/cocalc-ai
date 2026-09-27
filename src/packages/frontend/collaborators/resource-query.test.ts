import { resolveCollaborationResource } from "./resource-query";
import type { DirectoryApi } from "./workspace-api";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const target = {
  project_id: "project",
  kind: "conversation" as const,
  resource_id: "thread",
};
const resource = { ...target, title: "Seminar" } as CollaborationResource;

afterEach(() => jest.useRealTimers());

test("waits boundedly for a newly created thread to reach the index", async () => {
  jest.useFakeTimers();
  const getResource = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(resource);
  const result = resolveCollaborationResource(
    { getResource } as unknown as DirectoryApi,
    target,
    true,
  );
  await jest.runAllTimersAsync();
  await expect(result).resolves.toEqual(resource);
  expect(getResource).toHaveBeenCalledTimes(3);
});

test("old missing resources are not repeatedly queried", async () => {
  const getResource = jest.fn().mockResolvedValue(null);
  await expect(
    resolveCollaborationResource(
      { getResource } as unknown as DirectoryApi,
      target,
    ),
  ).rejects.toThrow("unavailable");
  expect(getResource).toHaveBeenCalledTimes(1);
});

test("cancelling the selected lookup stops indexing retries", async () => {
  jest.useFakeTimers();
  const abort = new AbortController();
  const getResource = jest.fn().mockResolvedValue(null);
  const result = resolveCollaborationResource(
    { getResource } as unknown as DirectoryApi,
    target,
    true,
    abort.signal,
  );
  const rejected = expect(result).rejects.toThrow("cancelled");
  await Promise.resolve();
  abort.abort();
  await rejected;
  await jest.runAllTimersAsync();
  expect(getResource).toHaveBeenCalledTimes(1);
});

test("a different resolved identity is rejected", async () => {
  const getResource = jest
    .fn()
    .mockResolvedValue({ ...resource, resource_id: "other" });
  await expect(
    resolveCollaborationResource(
      { getResource } as unknown as DirectoryApi,
      target,
    ),
  ).rejects.toThrow("different resource");
});
