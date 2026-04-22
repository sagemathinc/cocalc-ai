import {
  COCALC_BIN,
  COCALC_BIN2,
  COCALC_LIB,
  DEFAULT_PROJECT_TOOLS,
  PROJECT_BUNDLE_BIN_PATH,
  PROJECT_BUNDLES_CURRENT_BIN_PATH,
  getCoCalcMounts,
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
  it("falls back to the canonical host tools path when env is absent", () => {
    const mounts = getCoCalcMounts(
      {},
      (path) => path === DEFAULT_PROJECT_TOOLS,
    );

    expect(mounts[DEFAULT_PROJECT_TOOLS]).toBe(COCALC_BIN2);
  });

  it("prefers an explicit COCALC_PROJECT_TOOLS path when provided", () => {
    const explicitTools = "/srv/cocalc/tools/current";
    const mounts = getCoCalcMounts(
      { COCALC_PROJECT_TOOLS: explicitTools },
      (path) => path === explicitTools,
    );

    expect(mounts[explicitTools]).toBe(COCALC_BIN2);
    expect(mounts[DEFAULT_PROJECT_TOOLS]).toBeUndefined();
  });
});

describe("project bundle runtime paths", () => {
  it("prefers the stable current bundle bin before the version-specific fallback", () => {
    expect(projectBundleBinPathPrefix()).toBe(
      `${PROJECT_BUNDLES_CURRENT_BIN_PATH}:${PROJECT_BUNDLE_BIN_PATH}`,
    );
  });
});
