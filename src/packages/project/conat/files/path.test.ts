import { projectFilePath } from "./path";

describe("project file paths", () => {
  it("maps project-visible Windows paths into the workspace", () => {
    const options = {
      home: "C:\\Users\\Ada\\CoCalc",
      platform: "win32" as const,
    };
    expect(projectFilePath("notes\\todo.txt", options)).toBe(
      "C:\\Users\\Ada\\CoCalc\\notes\\todo.txt",
    );
    expect(projectFilePath("/home/user/notes/todo.txt", options)).toBe(
      "C:\\Users\\Ada\\CoCalc\\notes\\todo.txt",
    );
  });

  it("preserves native absolute Windows paths", () => {
    expect(
      projectFilePath("D:\\Shared\\file.txt", {
        home: "C:\\Users\\Ada\\CoCalc",
        platform: "win32",
      }),
    ).toBe("D:\\Shared\\file.txt");
  });

  it("retains Unix behavior", () => {
    expect(
      projectFilePath("notes/todo.txt", {
        home: "/home/user",
        platform: "linux",
      }),
    ).toBe("/home/user/notes/todo.txt");
  });

  it("maps canonical runtime-home paths into the workspace home on Unix", () => {
    const options = {
      home: "/home/hsy/p/cocalc-ai-data/projects/497cefe7",
      platform: "linux" as const,
      runtimeHome: "/home/user",
    };
    expect(projectFilePath("/home/user/latex/tex.pdf", options)).toBe(
      "/home/hsy/p/cocalc-ai-data/projects/497cefe7/latex/tex.pdf",
    );
    expect(projectFilePath("/home/user", options)).toBe(
      "/home/hsy/p/cocalc-ai-data/projects/497cefe7",
    );
    expect(projectFilePath("/tmp/scratch.txt", options)).toBe(
      "/tmp/scratch.txt",
    );
    expect(projectFilePath("latex/tex.pdf", options)).toBe(
      "/home/hsy/p/cocalc-ai-data/projects/497cefe7/latex/tex.pdf",
    );
  });

  it("passes absolute Unix paths through when no runtime home is set", () => {
    expect(
      projectFilePath("/home/user/latex/tex.pdf", {
        home: "/home/user",
        platform: "linux",
        runtimeHome: undefined,
      }),
    ).toBe("/home/user/latex/tex.pdf");
  });
});
