describe("project-api client explicit routing", () => {
  it("requires an explicit Conat client", async () => {
    const { projectApiClient } = await import("./project-client");

    expect(() =>
      projectApiClient({
        project_id: "00000000-1000-4000-8000-000000000000",
      } as any),
    ).toThrow("must provide an explicit Conat client");
  });

  it("uses the provided client for requests and readiness checks", async () => {
    const { projectApiClient } = await import("./project-client");
    const request = jest.fn().mockResolvedValue({ data: { ok: true } });
    const interest = jest.fn().mockResolvedValue(true);
    const waitForInterest = jest.fn().mockResolvedValue(undefined);
    const client = { request, interest, waitForInterest } as any;

    const api = projectApiClient({
      project_id: "00000000-1000-4000-8000-000000000000",
      client,
      timeout: 1234,
    });

    await expect(api.isReady()).resolves.toBe(true);
    await expect(api.waitUntilReady({ timeout: 55 })).resolves.toBeUndefined();
    await expect(api.system.configuration("main")).resolves.toEqual({
      ok: true,
    });

    expect(interest).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.api.-",
    );
    expect(waitForInterest).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.api.-",
      { timeout: 55 },
    );
    expect(request).toHaveBeenCalledWith(
      "project.00000000-1000-4000-8000-000000000000.api.-",
      { name: "system.configuration", args: ["main"] },
      { timeout: 1234, waitForInterest: true },
    );
  });
});
