# Agent-Supported Science Images

CoCalc AI should make scientific software feel native: a user names a tool from
their field, and an agent can install it, test it, demonstrate it in a notebook,
and package it into a reusable CoCalc image when that is the right product
shape.

## What We Are Building

The target workflow has two outputs:

1. A recipe guide for users who want to install a tool in a normal CoCalc Basic
   project.
2. A prebuilt RootFS image for tools that are large, slow, fragile, broadly
   useful, or need a polished default environment.

FEniCSx on CoCalc Basic is the prototype. The same pattern should generalize to
bioinformatics, geospatial analysis, numerical PDEs, chemistry, astronomy,
statistics, optimization, machine learning, and other technical domains.

## Agent Deliverables

For each tool or stack, the agent should produce:

- install notes for CoCalc Basic
- scriptable install commands
- a RootFS recipe when a reusable image is justified
- smoke tests that exercise real domain functionality
- a Jupyter notebook example with reliable CoCalc rendering
- image metadata for publish flows
- an audit file with sources inspected, tests run, residual risks, and blocked
  acceptance steps
- bug-report drafts or friction cards for CoCalc-specific failures

## Workflow

1. Start from upstream documentation and current package availability.
2. Choose the least surprising install strategy for CoCalc Basic.
3. Install in a normal project and record exact versions.
4. Write smoke tests before writing final docs.
5. Build a notebook that proves real scientific use, not only imports.
6. Convert the install into a deterministic RootFS recipe when appropriate.
7. Run `rootfs recipe run --here` in the current project.
8. Run a clean builder-project build from an admin-authenticated session.
9. Publish only after a fresh project created from the image passes acceptance.
10. Capture every CoCalc-specific rough edge in a skill reference, docs page,
    audit note, or upstream bug report.

## Quality Gates

A tool is not ready for a prebuilt image until:

- the recipe is deterministic enough to rebuild
- all verify steps pass
- the default kernel and wrappers work
- domain smoke tests pass
- examples render in CoCalc without hidden X11/OpenGL/browser assumptions
- the image metadata is complete
- a fresh project using the image passes the same tests

## Agent Memory

The durable agent-facing knowledge lives in `src/.skills/cocalc`. That skill is
mounted into project-host Codex runtimes as the built-in `cocalc` skill when the
host skill copy exists. The skill should stay concise and route details into
references:

- CLI/auth/browser operations
- live Jupyter notebook operations
- RootFS image workflows
- science-tool onboarding
- friction cards for recurring CoCalc failures

When a task uncovers a new nuance, update the right durable artifact. Chat
history is not enough.

## FEniCSx Lessons To Reuse

- Use an isolated `/opt/<tool>` environment for large scientific stacks that
  should not disturb CoCalc's default Python.
- Treat project-scoped agent auth as a real boundary; clean image publish needs
  admin-authenticated CLI/UI.
- Use live notebook APIs for notebook edits and execution.
- Prefer CoCalc-safe notebook display formats. Matplotlib JavaScript HTML
  animation can show only `not available`; `image/gif` is a robust fallback.
- Separate numerical-solve validation from visualization validation.
