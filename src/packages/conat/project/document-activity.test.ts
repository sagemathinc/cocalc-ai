describe("project document-activity explicit routing", () => {
  it("requires an explicit Conat client for document activity requests", async () => {
    const { getFileUseTimes, listRecent, markFile } =
      await import("./document-activity");
    const account_id = "00000000-0000-4000-8000-000000000001";
    const project_id = "00000000-1000-4000-8000-000000000000";

    await expect(
      markFile({
        account_id,
        project_id,
        path: "foo.txt",
        action: "open",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");

    await expect(
      listRecent({
        account_id,
        project_id,
      }),
    ).rejects.toThrow("must provide an explicit Conat client");

    await expect(
      getFileUseTimes({
        account_id,
        project_id,
        path: "foo.txt",
      }),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
