describe("files write explicit routing", () => {
  it("requires an explicit Conat client for createServer", async () => {
    const { createServer } = await import("./write");

    await expect(
      createServer({
        project_id: "00000000-1000-4000-8000-000000000000",
        createWriteStream: () => null,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for writeFile", async () => {
    const { writeFile } = await import("./write");
    const stream = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from("test");
      },
    };

    await expect(
      writeFile({
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/test",
        stream,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
