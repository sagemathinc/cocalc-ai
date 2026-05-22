# Product Notes From Drafting This Guide

These are product ideas that became more obvious while writing the
paper-polishing guide. They are not part of the user-facing guide copy.

## Strong Ideas

### Paper workspace template

CoCalc-AI could offer a first-class `Paper` workspace template that creates a
small, conventional layout:

```text
paper/
  paper.tex
  references.bib
  figures/
  notebooks/
  notes.md
```

This is not much code, but it would give Codex a predictable project shape and
make the guide feel immediately actionable.

### Paper review prompt pack

The guide naturally wants a few reusable agent intents:

- `Review this LaTeX paper for structure`
- `Find undefined notation`
- `Check theorem/proof dependency order`
- `Update paper text from notebook output`
- `Build the PDF and triage warnings`

These should be product actions, not prose that users have to rediscover.

### Build-aware LaTeX agent loop

The ideal behavior is:

1. Codex edits a narrow LaTeX region.
2. CoCalc runs the LaTeX build.
3. Build warnings/errors become structured context.
4. Codex proposes a follow-up patch.
5. The user reviews one patch at a time.

This is stronger than a generic file-editing agent because LaTeX build output is
high-signal and should be part of the loop.

### Notebook-to-paper provenance

When a notebook output updates a table or figure in a paper, CoCalc could record
a lightweight provenance note:

- notebook path
- cell or run id
- generated artifact path
- LaTeX label or figure/table reference

This would make computational claims easier to audit later.

## Smaller UX Ideas

### Workspace-scoped paper checklist

For a paper workspace, a visible checklist could track:

- PDF builds
- unresolved references
- bibliography warnings
- notebooks with stale outputs
- figures modified after the last PDF build

This should be workspace-scoped, not project-global.

### Advisor handoff mode

The guide wants a clean “send to advisor” moment. Product behavior could package:

- current PDF
- source diff
- agent thread summary
- changed notebooks/figures

This might be a share/export workflow rather than a new editor feature.

### Agent guardrails for mathematical authority

For mathematical writing, CoCalc should nudge Codex toward review and
verification language:

- ask for structure, notation, missing assumptions, and build failures
- avoid unsupported theorem rewrites
- distinguish conjecture, evidence, proof, and exposition

This could be part of the prompt template for paper-related actions.
