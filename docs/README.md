# Repository documentation

This directory contains architecture, development, and operator references for
the CoCalc-AI source tree. User-facing guides are maintained in the existing
[documentation registry](../src/packages/docs/src/entries/index.ts) and published
in the [CoCalc documentation browser](https://cocalc.ai/docs).

Start with the reference for your task:

- Product and package layout: [repository README](../README.md).
- Build and local development: [source guide](../src/README.md) and
  [development helpers](../src/scripts/dev/README.md).
- Architecture and operations: [reference index](overview.md).
- Browser debugging: [browser-debugging.md](browser-debugging.md).
- Public CLI guide validation: [cli-guide-validation.md](cli-guide-validation.md).
- Contributor style: [STYLE.md](STYLE.md).

Documents marked as drafts or plans describe design intent and open work. The
working notes in `src/.agents/` also include historical and proposed behavior;
check the owning implementation and tests before using a note as an operating
procedure. A source reference, successful component check, and tested deployment
are different kinds of evidence.
