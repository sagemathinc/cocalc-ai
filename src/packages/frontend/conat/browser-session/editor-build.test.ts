import { fromJS, Map as IMap } from "immutable";

import { BROWSER_EXEC_API_DECLARATION } from "./exec-api-declaration";
import { readEditorBuildOutcome, runEditorBuild } from "./editor-build";
import { MAX_SUCCESSFUL_BUILD_LOG_CHARS } from "@cocalc/frontend/frame-editors/generic/build-outcome";

describe("readEditorBuildOutcome", () => {
  it("summarizes the multi-stage LaTeX build_logs", () => {
    const store = IMap({
      build_logs: fromJS({
        latex: {
          exit_code: 1,
          stdout: "! Undefined control sequence.",
          stderr: "latexmk failed",
          parse: { errors: [{ line: 3 }, { line: 9 }] },
        },
        bibtex: { exit_code: 0, stdout: "ok" },
      }),
    });

    expect(readEditorBuildOutcome(store)).toEqual({
      exit_code: 1,
      error_count: 2,
      log: "latexmk failed\n! Undefined control sequence.",
      jobs: [
        { name: "latex", exit_code: 1 },
        { name: "bibtex", exit_code: 0 },
      ],
    });
  });

  it("reports exit_code 0 when every LaTeX stage succeeded", () => {
    const store = IMap({
      build_logs: fromJS({
        latex: { exit_code: 0, stdout: "Output written on paper.pdf" },
      }),
    });

    expect(readEditorBuildOutcome(store)).toMatchObject({
      exit_code: 0,
      log: "Output written on paper.pdf",
      jobs: [{ name: "latex", exit_code: 0 }],
    });
  });

  it("keeps only the tail of a successful build's log", () => {
    // latexmk's log is mostly font paths and a dependency listing; the exit
    // code is the verification, so an agent should not pay for the rest
    const noise = "x".repeat(MAX_SUCCESSFUL_BUILD_LOG_CHARS * 2);
    const store = IMap({
      build_logs: fromJS({
        latex: {
          exit_code: 0,
          stdout: `${noise}Output written on paper.pdf (1 page)`,
        },
      }),
    });

    const { log = "" } = readEditorBuildOutcome(store);
    expect(log).toContain("Output written on paper.pdf (1 page)");
    expect(log).toContain("earlier chars");
    expect(log.length).toBeLessThan(MAX_SUCCESSFUL_BUILD_LOG_CHARS + 200);
  });

  it("keeps the whole log of a failing build", () => {
    // here the log is the evidence, and the error is near the top
    const long = `! Undefined control sequence.\n${"y".repeat(
      MAX_SUCCESSFUL_BUILD_LOG_CHARS * 2,
    )}`;
    const store = IMap({
      build_logs: fromJS({
        latex: { exit_code: 12, stdout: long, stderr: "" },
      }),
    });

    const { log = "" } = readEditorBuildOutcome(store);
    expect(log).toContain("! Undefined control sequence.");
    expect(log.length).toBeGreaterThan(MAX_SUCCESSFUL_BUILD_LOG_CHARS * 2);
  });

  it("reads the single build_exit/build_log/build_err triple of Rmd and qmd", () => {
    const store = IMap({
      build_exit: 1,
      build_log: "processing file: report.Rmd",
      build_err: "Error in eval: object 'x' not found",
    });

    expect(readEditorBuildOutcome(store)).toEqual({
      exit_code: 1,
      error: "Error in eval: object 'x' not found",
      log: "Error in eval: object 'x' not found\nprocessing file: report.Rmd",
    });
  });

  it("prefers the editor error state when it is set", () => {
    const store = IMap({ error: "cannot compile", build_exit: 0 });
    expect(readEditorBuildOutcome(store)).toMatchObject({
      error: "cannot compile",
      exit_code: 0,
    });
  });

  it("returns nothing for an editor that never built", () => {
    expect(readEditorBuildOutcome(IMap())).toEqual({});
    expect(readEditorBuildOutcome(undefined)).toEqual({});
  });
});

describe("runEditorBuild", () => {
  it("builds and reports the outcome from the editor store", async () => {
    const calls: any[][] = [];
    const editorActions = {
      build: async (...args: any[]) => {
        calls.push(args);
      },
      store: IMap({ build_exit: 0, build_log: "done" }),
    };

    const result = await runEditorBuild({
      editorActions,
      path: "/root/report.Rmd",
    });

    // force defaults to true: an unforced build() is a no-op while another
    // build runs, and the Rmd/qmd path is debounced, so we would otherwise
    // report stale store state as this build's result
    expect(calls).toEqual([["", true]]);
    expect(result).toEqual({
      path: "/root/report.Rmd",
      ext: "rmd",
      started: true,
      forced: true,
      awaited: true,
      exit_code: 0,
      log: "done",
    });
  });

  it("passes an explicit force=false through to the editor build", async () => {
    const calls: any[][] = [];
    const editorActions = {
      build: async (...args: any[]) => {
        calls.push(args);
      },
      store: IMap(),
    };

    await runEditorBuild({
      editorActions,
      path: "/root/paper.tex",
      options: { force: false },
    });

    expect(calls).toEqual([["", false]]);
  });

  it("returns immediately when wait is false", async () => {
    let finish: (() => void) | undefined;
    const editorActions = {
      build: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      store: IMap({ build_exit: 1 }),
    };

    const result = await runEditorBuild({
      editorActions,
      path: "/root/paper.tex",
      options: { wait: false },
    });

    expect(result).toEqual({
      path: "/root/paper.tex",
      ext: "tex",
      started: true,
      forced: true,
      awaited: false,
    });
    finish?.();
  });

  it("reports timed_out instead of hanging on a slow build", async () => {
    let finish: (() => void) | undefined;
    const editorActions = {
      build: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      store: IMap({ build_exit: 0 }),
    };

    const result = await runEditorBuild({
      editorActions,
      path: "/root/paper.tex",
      options: { timeout: 0.01 },
    });

    expect(result).toMatchObject({
      started: true,
      awaited: false,
      timed_out: true,
    });
    expect(result.exit_code).toBeUndefined();
    finish?.();
  });

  it("refuses to claim a build for a read-only preview", async () => {
    let called = false;
    await expect(
      runEditorBuild({
        editorActions: {
          build: async () => {
            called = true;
          },
          is_read_only_preview: () => true,
          store: IMap(),
        },
        path: "/root/paper.tex",
      }),
    ).rejects.toThrow("read-only preview");
    expect(called).toBe(false);
  });

  it("throws for an editor that has no build action", async () => {
    await expect(
      runEditorBuild({
        editorActions: { store: IMap() },
        path: "/root/notes.md",
      }),
    ).rejects.toThrow("does not support building");
  });

  it("propagates a build failure", async () => {
    await expect(
      runEditorBuild({
        editorActions: {
          build: async () => {
            throw Error("project is not running");
          },
          store: IMap(),
        },
        path: "/root/paper.tex",
      }),
    ).rejects.toThrow("project is not running");
  });
});

describe("browser exec API declaration", () => {
  it("documents editor.build so agents can discover it", () => {
    expect(BROWSER_EXEC_API_DECLARATION).toContain("api.editor.build(");
    expect(BROWSER_EXEC_API_DECLARATION).toContain("BrowserEditorBuildResult");
    expect(BROWSER_EXEC_API_DECLARATION).toMatch(
      /build: \(\s*path: string,\s*opts\?: BrowserEditorBuildOptions,\s*\) => Promise<BrowserEditorBuildResult>;/,
    );
  });
});
