describe("llm explicit routing", () => {
  it("requires an explicit Conat client", async () => {
    const { llm } = await import("./client");

    await expect(
      llm({
        account_id: "00000000-0000-4000-8000-000000000000",
        system: "system prompt",
        input: "hello",
      } as any),
    ).rejects.toThrow("must provide an explicit Conat client");
  });

  it("streams through an explicit client", async () => {
    const { llm } = await import("./client");
    const requestMany = jest.fn(async function* () {
      yield { data: { text: "hi", seq: 0 } };
      yield { data: null };
    });
    const client = { requestMany } as any;

    await expect(
      llm(
        {
          account_id: "00000000-0000-4000-8000-000000000000",
          system: "system prompt",
          input: "hello",
        } as any,
        client,
      ),
    ).resolves.toBe("hi");

    expect(requestMany).toHaveBeenCalledWith(
      expect.stringContaining("00000000-0000-4000-8000-000000000000"),
      expect.objectContaining({
        account_id: "00000000-0000-4000-8000-000000000000",
        system: "system prompt",
        input: "hello",
      }),
      expect.objectContaining({
        maxWait: 1000 * 60 * 10,
      }),
    );
  });
});
