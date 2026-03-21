import {
  COCALC_BIN,
  COCALC_LIB,
  getNodeRuntimeMounts,
} from "../project-runner/run/mounts";

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
