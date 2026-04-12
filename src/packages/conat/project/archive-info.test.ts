describe("project archive-info explicit routing", () => {
  it("requires an explicit Conat client for archive reads", async () => {
    const {
      getBackups,
      getBackupFiles,
      getBackupFileText,
      getSnapshotFileText,
    } = await import("./archive-info");
    const project_id = "00000000-1000-4000-8000-000000000000";

    await expect(getBackups({ project_id })).rejects.toThrow(
      "must provide an explicit Conat client",
    );
    await expect(
      getBackupFiles({
        project_id,
        id: "backup-1",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
    await expect(
      getBackupFileText({
        project_id,
        id: "backup-1",
        path: "file.txt",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
    await expect(
      getSnapshotFileText({
        project_id,
        snapshot: "snapshot-1",
        path: "file.txt",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
