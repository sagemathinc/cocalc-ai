import type {
  BuildStageEvent,
  BuildStageResult,
  BuildStageSpec,
  DocumentBuildRuntime,
  SavedBuildConfig,
} from "../src";
import { runDocumentBuild } from "../src";

interface Output {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  state?: BuildStageResult["state"];
}

class FakeRuntime implements DocumentBuildRuntime {
  readonly specs: BuildStageSpec[] = [];
  readonly copies: Array<[string, string]> = [];
  readonly files = new Map<string, string>();
  readonly existing = new Set<string>();
  readonly outputs = new Map<string, Output[]>();
  // Files each successive run of a stage creates, keyed by stage name and
  // consumed one entry per call like `outputs`. Lets a test show that a forced
  // re-run regenerates an input the earlier aggregated run did not produce.
  readonly creates = new Map<string, string[][]>();
  config?: SavedBuildConfig;
  clock = 1_000;

  queue(name: BuildStageSpec["name"], ...outputs: Output[]): void {
    this.outputs.set(name, outputs);
  }

  async readText(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }

  async readBuildConfig(): Promise<SavedBuildConfig | undefined> {
    return this.config;
  }

  async exists(path: string): Promise<boolean> {
    return this.existing.has(path);
  }

  async hash(path: string): Promise<string> {
    if (!this.existing.has(path)) {
      throw Object.assign(new Error(`ENOENT: no such file: ${path}`), {
        code: "ENOENT",
      });
    }
    return "sage-hash";
  }

  async execute(
    spec: BuildStageSpec,
    _onEvent: (event: BuildStageEvent) => void,
  ): Promise<BuildStageResult> {
    this.specs.push(spec);
    for (const path of this.creates.get(spec.name)?.shift() ?? []) {
      this.existing.add(path);
    }
    const output = this.outputs.get(spec.name)?.shift() ?? {};
    return {
      ...spec,
      state:
        output.state ??
        ((output.exit_code ?? 0) === 0 ? "succeeded" : "failed"),
      started_at: this.clock++,
      ended_at: this.clock++,
      exit_code: output.exit_code ?? 0,
      stdout: output.stdout ?? "",
      stderr: output.stderr ?? "",
    };
  }

  async copy(source: string, destination: string): Promise<void> {
    this.copies.push([source, destination]);
  }

  now(): number {
    return this.clock++;
  }
}

describe("LaTeX-family pipelines", () => {
  it("rejects a stale saved source before starting a stage", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "new saved content");
    const result = await runDocumentBuild(
      { path: "paper.tex", expected_source_hash: 123 },
      runtime,
    );
    expect(runtime.specs).toHaveLength(0);
    expect(result).toMatchObject({ state: "failed", exit_code: 1 });
    expect(result.diagnostics[0]).toMatchObject({
      source: "configuration",
      message: expect.stringContaining("changed before the build started"),
    });
  });

  it("runs a plain LaTeX build and emits immutable lifecycle snapshots", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "\\documentclass{article}");
    runtime.existing.add("paper.pdf");
    runtime.queue("latex", {
      stdout:
        "latexmk\n#===Dependents for paper.pdf:\nchapter.tex \\\n#===End dependents for paper.pdf:\n",
    });
    const states: string[] = [];
    const result = await runDocumentBuild(
      { path: "paper.tex", build_id: "build-1" },
      runtime,
      { onSnapshot: (snapshot) => states.push(snapshot.state) },
    );

    expect(runtime.specs.map((spec) => spec.name)).toEqual(["latex"]);
    expect(runtime.specs[0]).toMatchObject({
      logical_path: "paper.tex",
      working_path: "paper.tex",
      resource_key: "paper.tex",
      command: "latexmk",
      bash: false,
    });
    expect(runtime.copies).toEqual([
      [expect.stringMatching(/^\/tmp\/[a-f0-9]+\/paper\.pdf$/), "paper.pdf"],
    ]);
    expect(result).toMatchObject({
      build_id: "build-1",
      state: "succeeded",
      exit_code: 0,
      dependencies: ["chapter.tex"],
      artifacts: [{ path: "paper.pdf", type: "pdf" }],
    });
    expect(states[0]).toBe("queued");
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("succeeded");
  });

  it("runs Knitr before LaTeX and patches SyncTeX afterward", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.Rnw", "\\documentclass{article}");
    runtime.existing.add("paper.tex");
    runtime.existing.add("paper.pdf");
    const result = await runDocumentBuild({ path: "paper.Rnw" }, runtime);

    expect(runtime.specs.map((spec) => spec.name)).toEqual([
      "knitr",
      "latex",
      "patch-synctex",
    ]);
    expect(runtime.specs[0]).toMatchObject({
      logical_path: "paper.Rnw",
      working_path: "paper.tex",
      resource_key: "paper.tex",
    });
    expect(result.state).toBe("succeeded");
    expect(result.artifacts).toEqual([
      { path: "paper.tex", type: "tex" },
      { path: "paper.pdf", type: "pdf" },
    ]);
  });

  it("runs output-dir fallback, SageTeX, PythonTeX, and required reruns", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "\\documentclass{article}");
    runtime.existing.add("paper.pdf");
    runtime.queue(
      "latex",
      { stdout: "sagetex.sty pythontex.sty PythonTeX" },
      { stdout: "preprocessors pending" },
      { stdout: "after sage" },
      { stdout: "final" },
    );
    runtime.existing.add("paper.sagetex.sage");
    runtime.queue("sagetex", {
      stderr: "Sage processing complete successfully",
    });
    runtime.queue("pythontex", { stdout: "PythonTeX complete" });

    const result = await runDocumentBuild(
      { path: "paper.tex", generation: "saved-17", force: true },
      runtime,
    );
    expect(runtime.specs.map((spec) => spec.name)).toEqual([
      "latex",
      "latex",
      "sagetex",
      "latex",
      "pythontex",
      "latex",
    ]);
    expect(
      runtime.specs
        .filter((spec) => spec.name === "latex")
        .slice(1)
        .every(
          (spec) =>
            ![spec.command, ...(spec.args ?? [])]
              .join(" ")
              .includes("-output-directory"),
        ),
    ).toBe(true);
    expect(result.stages.filter((stage) => stage.name === "latex")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: false }),
        expect.objectContaining({ required: true }),
      ]),
    );
    expect(
      runtime.specs
        .filter(({ name }) => ["latex", "sagetex", "pythontex"].includes(name))
        .every(({ aggregate_key }) => aggregate_key == null),
    ).toBe(true);
    expect(result.state).toBe("succeeded");
  });

  it.each([
    ["two  spaces.tex"],
    ["author's-notes.tex"],
    ["sub/two  spaces.tex"],
    ["sub/author's-notes.tex"],
  ])("refuses to build %s", async (path) => {
    const runtime = new FakeRuntime();
    runtime.files.set(path, "\\documentclass{article}");
    const result = await runDocumentBuild({ path }, runtime);
    expect(runtime.specs).toHaveLength(0);
    expect(result.state).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      source: "configuration",
      message: expect.stringContaining("not possible to compile"),
    });
  });

  it("builds a file whose directory contains spaces and a quote", async () => {
    // Only the basename reaches the build command; the directory is passed as
    // cwd, so it does not have to be shell-safe.
    const runtime = new FakeRuntime();
    const path = "bad  dir/author's-dir/paper.tex";
    runtime.files.set(path, "\\documentclass{article}");
    runtime.queue("latex", { stdout: "latexmk" });
    const result = await runDocumentBuild({ path }, runtime);
    expect(runtime.specs.map((spec) => spec.name)).toEqual(["latex"]);
    expect(runtime.specs[0].cwd).toBe("bad  dir/author's-dir");
    expect(result.state).toBe("succeeded");
  });

  it("re-runs LaTeX when the generated SageTeX input is missing", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "\\documentclass{article}");
    runtime.queue(
      "latex",
      { stdout: "sagetex.sty" },
      { stdout: "regenerated sagetex.sty" },
      { stdout: "after sage" },
    );
    runtime.queue("sagetex", {
      stderr: "Sage processing complete successfully",
    });

    // The first pass is aggregated away and produces nothing; only the forced
    // second pass regenerates the SageTeX input.
    runtime.creates.set("latex", [[], ["paper.sagetex.sage"]]);

    const result = await runDocumentBuild(
      { path: "paper.tex", generation: "saved-17", output_directory: null },
      runtime,
    );

    // The first LaTeX pass could be aggregated away, so a forced pass runs
    // before sagetex instead of the build dying on the missing input.
    expect(runtime.specs.map((spec) => spec.name)).toEqual([
      "latex",
      "latex",
      "sagetex",
      "latex",
    ]);
    expect(runtime.specs[0].aggregate_key).toBe("saved-17");
    expect(runtime.specs[1].aggregate_key).toBeUndefined();
    // The regenerated file was hashed, so sagetex can aggregate normally.
    expect(
      runtime.specs.find((spec) => spec.name === "sagetex")?.aggregate_key,
    ).toBe("sage-hash");
    expect(
      result.diagnostics.filter((d) => d.source === "transport"),
    ).toHaveLength(0);
    expect(result.state).toBe("succeeded");
  });

  it("still runs SageTeX when the input cannot be regenerated", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "\\documentclass{article}");
    runtime.queue(
      "latex",
      { stdout: "sagetex.sty" },
      { stdout: "still no sagetex input" },
      { stdout: "after sage" },
    );
    runtime.queue("sagetex", { stderr: "Sage processing complete" });

    const result = await runDocumentBuild(
      { path: "paper.tex", generation: "saved-17", output_directory: null },
      runtime,
    );

    // No hash could be computed, so sagetex must not be deduped against an
    // earlier run whose input we could not identify.
    expect(
      runtime.specs.find((spec) => spec.name === "sagetex")?.aggregate_key,
    ).toBeUndefined();
    expect(
      result.diagnostics.filter((d) => d.source === "transport"),
    ).toHaveLength(0);
    expect(result.state).toBe("succeeded");
  });

  it("does not run later stages after a failed preprocessor", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("paper.tex", "\\documentclass{article}");
    runtime.existing.add("paper.sagetex.sage");
    runtime.queue("latex", { stdout: "sagetex.sty" }, { stdout: "pending" });
    runtime.queue("sagetex", { exit_code: 2, stderr: "sage failed" });

    const result = await runDocumentBuild({ path: "paper.tex" }, runtime);
    expect(runtime.specs.map((spec) => spec.name)).toEqual([
      "latex",
      "latex",
      "sagetex",
    ]);
    expect(result).toMatchObject({ state: "failed", exit_code: 2 });
  });

  it("fails on parsed LaTeX errors even if latexmk exits zero", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("bad.tex", "\\documentclass{article}");
    runtime.queue("latex", {
      stdout: "latexmk\n! Undefined control sequence.\nl.7 \\badcommand\n",
    });
    const result = await runDocumentBuild({ path: "bad.tex" }, runtime);
    expect(result.state).toBe("failed");
    expect(result.exit_code).toBe(1);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "latex", level: "error", line: 7 }),
      ]),
    );
  });
});

describe("Markdown pipelines", () => {
  it("builds R Markdown with the compatibility self-contained heuristic", async () => {
    const runtime = new FakeRuntime();
    runtime.files.set("my report.Rmd", "---\ntitle: Test\n---\ntext");
    runtime.existing.add("my-report.html");
    const result = await runDocumentBuild({ path: "my report.Rmd" }, runtime);
    expect(runtime.specs[0]).toMatchObject({
      name: "r-markdown",
      command: "Rscript",
      env: { MPLBACKEND: "Agg" },
      args: ["-e", expect.stringContaining("self_contained = FALSE")],
    });
    expect(result.artifacts).toEqual([
      { path: "my-report.html", type: "html" },
    ]);
  });

  it("returns Quarto source lines and a nonzero result", async () => {
    const runtime = new FakeRuntime();
    runtime.queue("quarto", {
      exit_code: 1,
      stderr: "Error: bad chunk\nQuitting from report.qmd:8-11 [broken]",
    });
    const result = await runDocumentBuild({ path: "report.qmd" }, runtime);
    expect(runtime.specs[0]).toMatchObject({
      command: "quarto",
      args: ["render", "report.qmd", "--log-level", "info"],
    });
    expect(result).toMatchObject({ state: "failed", exit_code: 1 });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "quarto",
          line: 8,
          end_line: 11,
        }),
      ]),
    );
  });

  it("reports saved-source read failures as transport diagnostics", async () => {
    const runtime = new FakeRuntime();
    runtime.readText = async () => {
      throw new Error("source is unavailable");
    };
    const result = await runDocumentBuild({ path: "report.Rmd" }, runtime);
    expect(result).toMatchObject({ state: "failed", exit_code: 1 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        source: "transport",
        level: "error",
        message: "source is unavailable",
      }),
    ]);
  });
});
