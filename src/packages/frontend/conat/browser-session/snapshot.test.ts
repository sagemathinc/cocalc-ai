jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(() => ({
      get: jest.fn(() => undefined),
    })),
  },
  project_redux_name: (project_id: string) => `project-${project_id}`,
}));

import { getActiveProjectIdFallback, getProjectIdFromUrl } from "./snapshot";

describe("browser-session snapshot helpers", () => {
  it("extracts a project id from a project-scoped URL", () => {
    expect(
      getProjectIdFromUrl(
        "http://localhost:9100/projects/00000000-1000-4000-8000-000000000111/files/home/user/?_cocalc_browser_spawn=test",
      ),
    ).toBe("00000000-1000-4000-8000-000000000111");
  });

  it("uses the URL project id when open project metadata is not ready", () => {
    expect(
      getActiveProjectIdFallback({
        openProjectIds: [],
        url: "http://localhost:9100/projects/00000000-1000-4000-8000-000000000222/files/home/user/",
      }),
    ).toBe("00000000-1000-4000-8000-000000000222");
  });

  it("does not claim an active project on a non-project URL", () => {
    expect(
      getActiveProjectIdFallback({
        openProjectIds: ["00000000-1000-4000-8000-000000000333"],
        url: "http://localhost:9100/hosts",
      }),
    ).toBeUndefined();
  });

  it("falls back to open project metadata only when no URL is available", () => {
    expect(
      getActiveProjectIdFallback({
        openProjectIds: ["00000000-1000-4000-8000-000000000333"],
      }),
    ).toBe("00000000-1000-4000-8000-000000000333");
  });
});
