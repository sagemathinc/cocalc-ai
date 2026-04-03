describe("files read explicit routing", () => {
  it("requires an explicit Conat client for createServer", async () => {
    const { createServer } = await import("./read");

    await expect(
      createServer({
        project_id: "00000000-1000-4000-8000-000000000000",
        createReadStream: () => null,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for readFile", async () => {
    const { readFile } = await import("./read");

    const iterator = readFile({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/test",
    });
    await expect(iterator.next()).rejects.toThrow(
      "must provide an explicit Conat client",
    );
  });
});
