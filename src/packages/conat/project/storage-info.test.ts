describe("project storage-info explicit routing", () => {
  it("requires an explicit Conat client for overview requests", async () => {
    const { getStorageOverview } = await import("./storage-info");

    await expect(
      getStorageOverview({
        project_id: "00000000-1000-4000-8000-000000000000",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
