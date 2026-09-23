import { initHubApi, transformArgs } from "./index";

test("catalog entry RPC binds the human account and preserves the lookup IDs", async () => {
  const name = "artifactCatalog.getEntry";
  const request = { project_id: "project", entry_id: "a".repeat(64) };
  await expect(
    transformArgs({
      name,
      args: [{ ...request, account_id: "forged" }],
      account_id: "actual",
    }),
  ).resolves.toEqual([{ ...request, account_id: "actual" }]);
  for (const actor of [
    {},
    { host_id: "host" },
    { project_id: "project" },
    { account_id: "agent", auth_actor: "agent" as const },
  ])
    await expect(
      transformArgs({ name, args: [request], ...actor }),
    ).rejects.toThrow();
});

test("hub entry client preserves metadata and null responses", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ entry_id: "a".repeat(64) });
  const api = initHubApi(call);
  const request = { project_id: "project", entry_id: "a".repeat(64) };
  await expect(api.artifactCatalog.getEntry(request)).resolves.toBeNull();
  await expect(api.artifactCatalog.getEntry(request)).resolves.toEqual({
    entry_id: request.entry_id,
  });
});
