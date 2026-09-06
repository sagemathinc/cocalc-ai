import { initHubApi, transformArgs } from "./index";

it("registers the public acknowledgement client, not only its TypeScript interface", async () => {
  const call = jest.fn().mockResolvedValue([]);
  const client = initHubApi(call);
  await client.projects.backupWarningAcknowledgements({
    project_id: "00000000-0000-4000-8000-000000000001",
  });
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({ name: "projects.backupWarningAcknowledgements" }),
  );
});

it("binds warning preferences to the authenticated account and rejects project/host-only auth", async () => {
  const args = [
    { project_id: "project", account_id: "forged", key: "a".repeat(64) },
  ];
  expect(
    await transformArgs({
      name: "projects.backupWarningAcknowledgements",
      args,
      account_id: "actual",
    }),
  ).toEqual([
    { project_id: "project", account_id: "actual", key: "a".repeat(64) },
  ]);
  await expect(
    transformArgs({
      name: "projects.backupWarningAcknowledgements",
      args: [{ account_id: "forged" }],
      project_id: "project",
    }),
  ).rejects.toThrow("signed in");
  await expect(
    transformArgs({
      name: "projects.backupWarningAcknowledgements",
      args: [{ account_id: "forged" }],
      host_id: "host",
    }),
  ).rejects.toThrow("signed in");
});
