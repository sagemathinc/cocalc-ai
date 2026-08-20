import {
  createMessage,
  createNavigatorIntentMessage,
} from "./help-me-fix-utils";

describe("createNavigatorIntentMessage", () => {
  it("tells the agent to use live sync state instead of relying on disk", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "/tmp/test.ipynb",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    expect(prompt).toContain(
      "Treat the live in-memory sync version of the document as the source of truth.",
    );
    expect(prompt).toContain(
      "Do not rely on the filesystem copy being current; use live document APIs when available.",
    );
    expect(prompt).not.toContain("codex_model");
  });

  it("leaves the build instructions out for a file that has no build", () => {
    // help-me-fix also runs on notebooks, scripts and terminal output
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "/tmp/test.ipynb",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    expect(prompt).not.toContain("cocalc project build");
    expect(prompt).not.toContain("post_fix_build");
  });

  it("tells the agent to re-run the editor build after fixing a document", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "/home/user/paper.tex",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    expect(prompt).toContain(
      '`cocalc project build "/home/user/paper.tex" --wait`',
    );
    expect(prompt).toContain(
      "Do not run latexmk, quarto or the `build_command` below in a shell yourself",
    );
    expect(prompt).toContain('"command": "cocalc project build <path> --wait"');
  });

  it("names the document by absolute path, which is what the CLI takes", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "latex/paper.tex",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    expect(prompt).toContain(
      '`cocalc project build "/home/user/latex/paper.tex" --wait`',
    );
  });

  it("offers browser exec only as a fallback, not the primary path", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "/home/user/paper.tex",
      isHint: false,
      sourceTag: "help-me-fix:solution",
    });

    const primary = prompt.indexOf("cocalc project build");
    const fallback = prompt.indexOf("api.editor.build");
    expect(primary).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(primary);
    expect(prompt).toContain(
      "If the CLI is unavailable, fall back to browser exec",
    );
  });

  it("keeps the build instruction out of the user-visible message", () => {
    const message = createMessage({
      error: "! Undefined control sequence.",
      line: "\\foo",
      language: "tex",
      open: true,
      full: true,
    });

    expect(message).not.toContain("api.editor.build");
    expect(message).not.toContain("cocalc project build");
  });
});

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));

describe("help-me-fix prompts point the agent at the file and line", () => {
  it("includes the document and error location in the intent message", () => {
    const prompt = createNavigatorIntentMessage({
      message: "Help me fix this.",
      project_id: "project-1",
      path: "latex/paper.tex",
      isHint: false,
      sourceTag: "help-me-fix:solution",
      location: {
        path: "latex/chapters/intro.tex",
        absolute_path: "/home/user/latex/chapters/intro.tex",
        line: 42,
        line_end: 42,
      },
    });
    expect(prompt).toContain(
      "The document being edited is file `latex/paper.tex` (absolute path `/home/user/latex/paper.tex`).",
    );
    expect(prompt).toContain(
      "The error itself is reported in file `latex/chapters/intro.tex` (absolute path `/home/user/latex/chapters/intro.tex`) line 42.",
    );
    expect(prompt).toContain('"error_line": 42');
    expect(prompt).toContain('"absolute_path": "/home/user/latex/paper.tex"');
    expect(prompt).not.toContain("<details");
  });

  it("records the build command only in the intent metadata", () => {
    const message = createMessage({
      error: "! LaTeX Error: File `foo.sty' not found.",
      line: "",
      language: "latex",
      task: "ran latex",
    });
    expect(message).not.toContain("latexmk");
    const prompt = createNavigatorIntentMessage({
      message,
      project_id: "project-1",
      path: "latex/paper.tex",
      isHint: false,
      sourceTag: "help-me-fix:solution",
      buildCommand: "latexmk -pdf paper.tex",
    });
    expect(prompt).toContain('"build_command": "latexmk -pdf paper.tex"');
  });

  it("includes the location in the user-facing context message", () => {
    const message = createMessage({
      error: "Undefined control sequence.",
      line: "\\foo",
      language: "latex",
      location: {
        path: "latex/paper.tex",
        absolute_path: "/home/user/latex/paper.tex",
        line: 7,
        line_end: 7,
      },
    });
    expect(message).toContain(
      "The problem is in file `latex/paper.tex` (absolute path `/home/user/latex/paper.tex`) line 7.",
    );
    expect(message).toContain("Undefined control sequence.");
  });
});
