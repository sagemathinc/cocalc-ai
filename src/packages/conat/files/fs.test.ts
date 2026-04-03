describe("filesystem explicit routing", () => {
  it("requires an explicit Conat client for fsClient", async () => {
    const { fsClient } = await import("./fs");

    expect(() =>
      fsClient({
        subject: "fs.project-00000000-0000-4000-8000-000000000000",
      } as any),
    ).toThrow("must provide an explicit Conat client");
  });

  it("requires an explicit Conat client for fsServer", async () => {
    const { fsServer } = await import("./fs");

    await expect(
      fsServer({
        service: "fs-test",
        fs: async () =>
          ({
            watch: jest.fn(),
          }) as any,
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });
});
