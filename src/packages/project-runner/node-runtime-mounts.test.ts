import {
  COCALC_BIN,
  COCALC_BIN2,
  COCALC_LIB,
  COCALC_SRC,
  DEFAULT_PROJECT_TOOLS,
  DEFAULT_MANAGED_HARNESSES,
  PROJECT_BUNDLE_BIN_PATH,
  PROJECT_BUNDLES_CURRENT_BIN_PATH,
  getCoCalcMounts,
  MANAGED_HARNESSES_MOUNT_POINT,
  getNodeRuntimeMounts,
  projectBundleBinPathPrefix,
} from "./run/mounts";

describe("getNodeRuntimeMounts", () => {
  it("mounts the sibling lib directory for npm-style node installs", () => {
    const mounts = getNodeRuntimeMounts(
      "/runtime/node-v24.14.0-linux-x64/bin/node",
      (path) => path === "/runtime/node-v24.14.0-linux-x64/lib",
    );

    expect(mounts).toEqual({
      "/runtime/node-v24.14.0-linux-x64/bin": COCALC_BIN,
      "/runtime/node-v24.14.0-linux-x64/lib": COCALC_LIB,
    });
  });

  it("does not mount a missing sibling lib directory", () => {
    const mounts = getNodeRuntimeMounts(
      "/runtime/node-v24.14.0-linux-x64/bin/node",
      () => false,
    );

    expect(mounts).toEqual({
      "/runtime/node-v24.14.0-linux-x64/bin": COCALC_BIN,
    });
  });
});

describe("getCoCalcMounts", () => {
  it("mounts managed harnesses read-only through the caller", () => {
    const mounts = getCoCalcMounts({}, (path) =>
      [DEFAULT_MANAGED_HARNESSES].includes(path),
    );
    expect(mounts[DEFAULT_MANAGED_HARNESSES]).toBe(
      MANAGED_HARNESSES_MOUNT_POINT,
    );
  });
  it("falls back to the canonical host tools path when env is absent", () => {
    const mounts = getCoCalcMounts(
      {},
      (path) => path === DEFAULT_PROJECT_TOOLS || path.endsWith("/src"),
    );

    expect(mounts[DEFAULT_PROJECT_TOOLS]).toBe(COCALC_BIN2);
    expect(Object.values(mounts)).toContain(COCALC_SRC);
  });

  it("prefers an explicit COCALC_PROJECT_TOOLS path when provided", () => {
    const explicitTools = "/srv/cocalc/tools/current";
    const mounts = getCoCalcMounts(
      { COCALC_PROJECT_TOOLS: explicitTools },
      (path) => path === explicitTools || path.endsWith("/src"),
    );

    expect(mounts[explicitTools]).toBe(COCALC_BIN2);
    expect(mounts[DEFAULT_PROJECT_TOOLS]).toBeUndefined();
    expect(Object.values(mounts)).toContain(COCALC_SRC);
  });

  it("skips missing project source mounts when tools exist", () => {
    const explicitTools = "/srv/cocalc/tools/current";
    const mounts = getCoCalcMounts(
      { COCALC_PROJECT_TOOLS: explicitTools },
      (path) => path === explicitTools,
    );

    expect(mounts[explicitTools]).toBe(COCALC_BIN2);
    expect(Object.values(mounts)).not.toContain(COCALC_SRC);
  });

  it("uses the legacy project bundle as the only project source mount", () => {
    const projectBundle = "/srv/cocalc/project/build/bundle";
    const mounts = getCoCalcMounts(
      { COCALC_PROJECT_BUNDLE: projectBundle },
      () => false,
    );
    const srcMounts = Object.entries(mounts).filter(
      ([, target]) => target === COCALC_SRC,
    );

    expect(mounts[`${projectBundle}/src`]).toBe(COCALC_SRC);
    expect(mounts[`${projectBundle}/bin`]).toBe(COCALC_BIN2);
    expect(srcMounts).toEqual([[`${projectBundle}/src`, COCALC_SRC]]);
  });
});

describe("project bundle runtime paths", () => {
  it("prefers the stable current bundle bin before the version-specific fallback", () => {
    expect(projectBundleBinPathPrefix()).toBe(
      `${PROJECT_BUNDLES_CURRENT_BIN_PATH}:${PROJECT_BUNDLE_BIN_PATH}`,
    );
  });
});
