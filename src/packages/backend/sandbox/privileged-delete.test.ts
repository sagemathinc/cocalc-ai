import {
  __test__,
  privilegedRemoveDirTarget,
  privilegedRemoveTarget,
} from "./privileged-delete";

describe("privileged-delete", () => {
  it("builds sandbox-rm sudo arguments", () => {
    expect(
      __test__.commandArgs(
        privilegedRemoveTarget({
          root: "/mnt/cocalc/project-123",
          rel: ".local/share/cocalc/rootfs/upperdir",
          options: { recursive: true, force: true },
        }),
      ),
    ).toEqual([
      "-n",
      "/usr/local/sbin/cocalc-runtime-storage",
      "sandbox-rm",
      "/mnt/cocalc/project-123",
      ".local/share/cocalc/rootfs/upperdir",
      "--recursive",
      "--force",
    ]);
  });

  it("builds sandbox-rmdir arguments", () => {
    expect(
      __test__.commandArgs(
        privilegedRemoveDirTarget({
          root: "/mnt/cocalc/project-123-scratch",
          rel: "tmp/build",
          options: {},
        }),
      ),
    ).toEqual([
      "-n",
      "/usr/local/sbin/cocalc-runtime-storage",
      "sandbox-rmdir",
      "/mnt/cocalc/project-123-scratch",
      "tmp/build",
    ]);
  });

  it("rejects absolute or escaping relative paths", () => {
    expect(() =>
      __test__.validateDeleteTarget({
        root: "/mnt/cocalc/project-123",
        rel: "/etc/passwd",
      }),
    ).toThrow("relative");
    expect(() =>
      __test__.validateDeleteTarget({
        root: "/mnt/cocalc/project-123",
        rel: "../escape",
      }),
    ).toThrow("beneath root");
  });
});
