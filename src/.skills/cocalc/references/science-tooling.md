# Science Tooling Onboarding

## End Goal

Make CoCalc AI feel native for every scientific field: a user names a favorite
tool, and the agent can find the right install route, install or package it,
test real domain functionality, provide notebook examples, and decide whether a
prebuilt CoCalc image is warranted.

This applies to finite elements, numerical PDEs, statistics, geospatial work,
bioinformatics, chemistry, astronomy, physics, optimization, machine learning,
symbolic math, visualization, and similar fields.

## Deliverables

For a tool or stack, produce:

- a plain-language install guide for CoCalc Basic
- a scriptable install path
- a RootFS recipe when the install is large, slow, fragile, or broadly useful
- smoke tests that exercise real functionality
- notebook examples using CoCalc-safe renderers
- image metadata for publication if applicable
- audit notes and residual risks
- upstream bug reports or friction cards for CoCalc-specific failures

## Decision Tree

Use an install recipe only when the tool is small, fast, user-specific, or still
experimental.

Create a prebuilt RootFS image when the install is slow, large, fragile,
requires native libraries/MPI/GPUs, benefits many users, or needs a polished
default Jupyter kernel.

Prefer package-manager-native installs when they are current and reliable.
Prefer isolated environments under `/opt/<tool>` when the stack is large or
could destabilize CoCalc's default Python.

## Research And Testing Pattern

1. Identify the current recommended upstream install route.
2. Check what the CoCalc Basic base OS already provides.
3. Select the least surprising install strategy.
4. Pin versions where drift would break the image.
5. Install in the current project and record exact versions.
6. Write smoke tests before writing docs.
7. Build a notebook that demonstrates the real scientific workflow.
8. Convert install steps into recipe form.
9. Run local recipe verification.
10. Hand off clean-build and publish steps if admin auth is required.

## Notebook Standard

Examples should answer: "Can a scientist immediately trust this environment?"

Include:

- package versions
- one domain solve/query/computation
- one visualization that works in CoCalc
- one parallel/GPU/kernel check when relevant
- compact assertions so failures are obvious

Avoid:

- purely import-only examples
- GUI/X11/OpenGL assumptions unless tested
- JavaScript-only animation output unless tested in CoCalc
- hidden dependency on user-local files

## Handoff Standard

When the task exposes a repeatable nuance, write it down in the most durable
place:

- product/runtime rule: runtime guidance or this skill
- workflow detail: skill reference
- human process: `docs/`
- project-specific evidence: `AUDIT.md`
- UI/product bug: bug-report draft with a minimal reproducer
