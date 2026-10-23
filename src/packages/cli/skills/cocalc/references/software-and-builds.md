# Software installs and document builds

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

## Software Installs: Check RootFS Recipes First

When asked to install software, language runtimes, Jupyter kernels, app launchers,
IDEs, or larger toolchains in a CoCalc project, check the built-in RootFS recipes
before hand-writing `apt`, `pip`, `curl`, or similar install commands:

```bash
cocalc rootfs recipe ls
cocalc rootfs recipe explain <recipe-or-module>
```

If a matching recipe exists and the user wants it installed into the current
project, prefer:

```bash
cocalc rootfs recipe run <recipe-or-module> --here
```

This runs recipe commands locally in the current project and writes portable
RootFS publish metadata under `/home/user/.cocalc/rootfs-recipes/`.

Use explicit filesystem recipes or module registries when needed:

```bash
cocalc rootfs recipe run ./recipe.yaml --here
cocalc rootfs recipe run my/module --module-dir ./rootfs-recipes --here
```

Fall back to manual installs only when no recipe fits, the recipe is unsuitable
for the request, or the user explicitly asks for a custom/manual installation. If
a recipe fails, inspect its output and fix the immediate issue before abandoning
it.

## Document Builds: Use The Complete Project Pipeline

When creating, editing, or verifying a supported document, inspect the installed
command first and then run the complete project-side build:

```bash
cocalc project build -h
cocalc project build path/to/paper.tex
```

Supported source extensions are:

- `.tex` for LaTeX, including required SageTeX and PythonTeX stages
- `.Rnw` and `.Rtex` for Knitr followed by the complete LaTeX pipeline
- `.Rmd` for R Markdown rendering
- `.qmd` for Quarto rendering

This is the same authoritative pipeline used by CoCalc editors. It runs on the
project, does not require an open browser, waits for completion by default, and
returns a nonzero process status when compilation or verification fails. Do not
substitute `pdflatex`, `latexmk`, `Rscript`, or `quarto` alone when the goal is to
verify the full CoCalc build pipeline.

The command builds saved project files. If a source is open with unsaved
collaborative changes, save it before starting the CLI build. A successful
process status means the complete selected pipeline succeeded; missing tools,
unsupported inputs, compiler failures, cancellation, stale-source rejection,
and timeouts are failures. Inspect human output or use the CLI's JSON mode for
the build ID, stages, diagnostics, artifacts, and final state.

Timeouts have separate meanings:

```bash
# Limit how long this CLI invocation waits. This does not cancel the build.
cocalc --timeout 20m project build path/to/paper.tex

# Set the project-side whole-build deadline. Expiry terminates the active stage.
cocalc project build path/to/paper.tex --build-timeout 15m
```

Use `--detach` when submission without waiting is intentional. Keep the returned
build ID so status can be inspected later. Treat `cocalc project build -h` and
the project service capability response as authoritative if available options
or supported formats differ from this bundled guidance.
