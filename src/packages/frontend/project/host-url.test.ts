/** @jest-environment jsdom */

describe("project host URL helpers", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";

  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(() => ({
          get: jest.fn(() => undefined),
        })),
        getActions: jest.fn(() => undefined),
      },
    }));
    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));
    jest.doMock("@cocalc/frontend/projects/host-info", () => ({
      getHostInfo: jest.fn(() => undefined),
    }));
  });

  it("does not duplicate the project id for localhost project-file URLs", async () => {
    const { withProjectHostBase } = await import("./host-url");
    const origin = window.location.origin;

    expect(
      withProjectHostBase(
        project_id,
        `http://127.0.0.1:9002/${project_id}/files/home/user/out.pdf?param=0`,
      ),
    ).toBe(`${origin}/${project_id}/files/home/user/out.pdf?param=0`);
  });

  it("adds the project id to localhost paths that are not already project-scoped", async () => {
    const { withProjectHostBase } = await import("./host-url");
    const origin = window.location.origin;

    expect(
      withProjectHostBase(
        project_id,
        "http://127.0.0.1:9002/files/home/user/out.pdf?param=0",
      ),
    ).toBe(`${origin}/${project_id}/files/home/user/out.pdf?param=0`);
  });
});
