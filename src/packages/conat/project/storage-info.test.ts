describe("project storage-info explicit routing", () => {
  it("requires an explicit Conat client for project storage requests", async () => {
    const { getDiskQuota, getSnapshotUsage, getStorageOverview } =
      await import("./storage-info");
    const project_id = "00000000-1000-4000-8000-000000000000";

    await expect(getDiskQuota({ project_id })).rejects.toThrow(
      "must provide an explicit Conat client",
    );
    await expect(getSnapshotUsage({ project_id })).rejects.toThrow(
      "must provide an explicit Conat client",
    );

    await expect(
      getStorageOverview({
        project_id,
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
