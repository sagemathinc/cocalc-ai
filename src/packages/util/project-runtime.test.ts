import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  isProjectRuntimeHomeAliasPath,
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

  it("normalizes path segments before checking runtime-home aliases", () => {
    expect(
      projectRuntimeHomeRelativePath("/home/user/projects/../demo/main.ts"),
    ).toBe("demo/main.ts");
  });

  it("does not treat unrelated absolute paths as runtime-home aliases", () => {
    expect(projectRuntimeHomeRelativePath("/root/work/file.txt")).toBe(
      "work/file.txt",
    );
    expect(isProjectRuntimeHomeAliasPath("/root/work/file.txt")).toBe(true);
    expect(isProjectRuntimeHomeAliasPath("/root")).toBe(true);
    expect(
      projectRuntimeHomeRelativePath("/opt/work/file.txt"),
    ).toBeUndefined();
    expect(projectRuntimeHomeRelativePath("/etc/passwd")).toBeUndefined();
    expect(isProjectRuntimeHomeAliasPath("/scratch/data.txt")).toBe(false);
  });
});
