import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  isProjectRuntimeHomeAliasPath,
  LEGACY_PROJECT_RUNTIME_HOME,
  projectRuntimeHomeRelativePath,
} from "./project-runtime";

describe("project runtime home helpers", () => {
  it("maps the canonical runtime home to a relative path", () => {
    expect(projectRuntimeHomeRelativePath(DEFAULT_PROJECT_RUNTIME_HOME)).toBe(
      "",
    );
    expect(
      projectRuntimeHomeRelativePath(
        `${DEFAULT_PROJECT_RUNTIME_HOME}/work/file.txt`,
      ),
    ).toBe("work/file.txt");
  });

  it("treats the legacy /root path as a runtime-home alias", () => {
    expect(projectRuntimeHomeRelativePath(LEGACY_PROJECT_RUNTIME_HOME)).toBe(
      "",
    );
    expect(projectRuntimeHomeRelativePath("/root/work/file.txt")).toBe(
      "work/file.txt",
    );
    expect(isProjectRuntimeHomeAliasPath("/root/work/file.txt")).toBe(true);
  });

  it("normalizes path segments before checking runtime-home aliases", () => {
    expect(
      projectRuntimeHomeRelativePath("/root/./work/../work/file.txt"),
    ).toBe("work/file.txt");
    expect(
      projectRuntimeHomeRelativePath("/home/user/projects/../demo/main.ts"),
    ).toBe("demo/main.ts");
  });

  it("does not treat unrelated absolute paths as runtime-home aliases", () => {
    expect(projectRuntimeHomeRelativePath("/etc/passwd")).toBeUndefined();
    expect(isProjectRuntimeHomeAliasPath("/scratch/data.txt")).toBe(false);
  });
});
