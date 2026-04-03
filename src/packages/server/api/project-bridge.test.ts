import projectBridge from "./project-bridge";

describe("projectBridge explicit routing", () => {
  it("uses the provided Conat client for project requests", async () => {
    const request = jest.fn().mockResolvedValue({ data: { ok: true } });
    const client = { request } as any;

    await expect(
      projectBridge({
        client,
        project_id: "00000000-1000-4000-8000-000000000000",
        name: "system.ping",
        args: [],
        timeout: 5000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.api.-",
      { name: "system.ping", args: [] },
      { timeout: 5000, waitForInterest: true },
    );
  });
});
