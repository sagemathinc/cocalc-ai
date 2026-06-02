describe("frontend/lib/cocalc-urls", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";

  beforeEach(() => {
    jest.resetModules();
  });

  it("builds ordinary project file URLs under the app base path", async () => {
    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "/",
    }));
    const { fileURL } = await import("./cocalc-urls");

    expect(fileURL({ project_id, path: "home/user/out.pdf" })).toBe(
      `/${project_id}/files/home/user/out.pdf`,
    );
  });

  it("does not duplicate the project id when the app base path is project-scoped", async () => {
    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: `/${project_id}`,
    }));
    const { fileURL } = await import("./cocalc-urls");

    expect(
      fileURL({
        project_id,
        path: "/home/user/out.pdf",
        param: "param=1",
      }),
    ).toBe(`/${project_id}/files/home/user/out.pdf?param=1`);
  });
});
