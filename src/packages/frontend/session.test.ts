import { projectsReadyForSessionRestore } from "./session";

function makeStore(values: Record<string, unknown>) {
  return {
    get(key: string) {
      return values[key];
    },
  };
}

describe("projectsReadyForSessionRestore", () => {
  it("uses open_projects readiness in lite mode", () => {
    const store = makeStore({
      open_projects: ["project-1"],
      project_map: null,
    });
    expect(
      projectsReadyForSessionRestore(store, {
        minimal: false,
        liteMode: true,
      }),
    ).toBe(true);
  });

  it("still requires project_map outside lite/minimal mode", () => {
    const store = makeStore({
      open_projects: ["project-1"],
      project_map: null,
    });
    expect(
      projectsReadyForSessionRestore(store, {
        minimal: false,
        liteMode: false,
      }),
    ).toBe(false);
  });
});
