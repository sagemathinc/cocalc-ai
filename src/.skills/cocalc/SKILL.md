---
name: cocalc
description: Operate CoCalc AI projects with the correct CoCalc CLI, browser automation, live Jupyter notebook, text editor sync, RootFS image, and science-tooling workflows. Use when Codex is working inside CoCalc or CoCalc AI, inspecting browser/project state, editing live notebooks or text files, installing scientific software, writing install recipes, testing publishable RootFS images, documenting friction, or diagnosing CoCalc-specific notebook/runtime/auth errors.
---

# CoCalc

Use this skill to act like an experienced CoCalc project agent instead of a
generic shell agent.

Canonical repo copy:

- `src/.skills/cocalc/SKILL.md`

Runtime copy:

- `~/.codex/skills/cocalc/SKILL.md`

When the repo copy changes, sync it to the runtime copy with:

- `pnpm -C src skill:cocalc:push`

## Start Here

1. Prefer the exact runtime guidance injected into the current turn over stale
   assumptions.
2. Use the CoCalc CLI command from the runtime guidance. In Launchpad projects
   it is usually:
   - `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`
3. Treat live CoCalc state as authoritative when the user may have unsaved
   browser/editor/notebook changes.
4. Pick the relevant reference before acting:
   - CLI, browser, auth, and scoped project tokens: `references/cli-auth.md`
   - Live Jupyter notebook inspection, edits, execution, and renderer traps:
     `references/notebooks.md`
   - RootFS recipes, clean builds, image publish, and acceptance tests:
     `references/rootfs-images.md`
   - Scientific software onboarding, recipe guides, smoke tests, notebooks, and
     prebuilt images: `references/science-tooling.md`
   - Known CoCalc friction symptoms and first responses:
     `references/friction-cards.md`

## Operating Contract

Preserve user state. For notebooks and collaborative text documents, use the
CoCalc live APIs unless the user explicitly asks for filesystem-level work.

Prefer high-signal commands. Use `cocalc project jupyter ...`,
`cocalc browser files`, and backend text APIs before raw browser JavaScript.

Name auth boundaries. If an operation fails because the agent token is scoped to
the current project, say that precisely and give the admin-authenticated CLI/UI
path. Do not pretend the agent can create projects, publish official images, or
perform fresh-auth admin mutations when the token says otherwise.

Convert hard-won lessons into durable artifacts. For a repeated failure or
workflow nuance, update the appropriate reference, docs page, runbook, recipe,
or bug-report draft instead of leaving it only in chat.

## Science Tooling Goal

For scientific fields, the end state is not merely "package installed." Produce
a path that a new user and a future agent can both use:

- install recipe for a normal CoCalc Basic project
- RootFS recipe for a clean publishable image when worthwhile
- smoke tests that exercise real domain functionality
- Jupyter examples that render reliably in CoCalc
- audit notes, residual risks, and final acceptance criteria
- friction cards or upstream bug reports for CoCalc-specific rough edges
