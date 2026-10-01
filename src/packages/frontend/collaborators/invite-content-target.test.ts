import { resolveInvitationContent } from "./invite-content-target";
import type { DirectoryApi } from "./workspace-api";

const project_id = "22222222-2222-4222-8222-222222222222";
const source = {
  project_id,
  chat_path: "/source.chat",
  thread_id: "native",
  kind: "artifact" as const,
  artifact_id: "artifact",
};
const resource = {
  ...source,
  resource_id: "copy:durable-id",
  entry_id: "not-the-resource-id",
  title: "Research",
  activity: 1,
};

function setup() {
  return {
    listProjectResources: jest.fn(),
    getResource: jest.fn().mockResolvedValue(resource),
  };
}

test("native content resolves the indexed copy identity and rechecks current authorization", async () => {
  const api = setup();
  api.listProjectResources
    .mockResolvedValueOnce({
      items: [{ ...resource, chat_path: "/other.chat" }],
      next: "page2",
    })
    .mockResolvedValueOnce({ items: [resource] });
  expect(
    await resolveInvitationContent(api as unknown as DirectoryApi, source),
  ).toEqual({
    project_id,
    kind: "artifact",
    resource_id: "copy:durable-id",
    label: "Research",
  });
  expect(api.listProjectResources).toHaveBeenLastCalledWith(
    expect.objectContaining({ project_id, after: "page2" }),
  );
  expect(api.getResource).toHaveBeenCalledWith({
    project_id,
    kind: "artifact",
    resource_id: "copy:durable-id",
  });
});

test("a stable target never needs source discovery", async () => {
  const api = setup();
  await resolveInvitationContent(api as unknown as DirectoryApi, resource);
  expect(api.listProjectResources).not.toHaveBeenCalled();
});

test("revoked access and a replaced identity cannot open a modal", async () => {
  const api = setup();
  api.getResource.mockResolvedValueOnce(null);
  await expect(
    resolveInvitationContent(api as unknown as DirectoryApi, resource),
  ).rejects.toThrow("unavailable");
  api.getResource.mockResolvedValueOnce({ ...resource, resource_id: "other" });
  await expect(
    resolveInvitationContent(api as unknown as DirectoryApi, resource),
  ).rejects.toThrow("different resource");
});

test("bounded discovery refuses missing content rather than guessing an artifact ID", async () => {
  const api = setup();
  api.listProjectResources.mockResolvedValue({ items: [], next: "same" });
  await expect(
    resolveInvitationContent(api as unknown as DirectoryApi, source),
  ).rejects.toThrow("not available");
  expect(api.listProjectResources).toHaveBeenCalledTimes(2);
  expect(api.getResource).not.toHaveBeenCalled();
});

test("cancelled native lookup never resolves content", async () => {
  const api = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(
    resolveInvitationContent(
      api as unknown as DirectoryApi,
      source,
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect(api.listProjectResources).not.toHaveBeenCalled();
});
