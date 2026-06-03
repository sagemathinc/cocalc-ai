# CoCalc Scripts

This directory is for repository-level operator and developer scripts.

Keep new scripts in a named subdirectory with a README unless there is a strong
reason for a top-level entry point. Top-level scripts should be actively used,
documented, or referenced from code.

## Top-Level Entry Points

- `build-local-codex-binaries.sh`: build patched local Codex binaries.
- `publish-local-codex-binaries.sh`: publish patched Codex binary assets.
- `check_doc_urls.py` and `check_doc_urls.skip`: documentation/link checker.
- `export-api-doc.ts`: export API documentation JSON.
- `run-ci.sh`: local full clean/build/test helper.

## Active Product And Release Workflows

- `star/`: CoCalc Star release build, install, smoke, and public installer
  entry points.
- `star-poc/`: shared Star bootstrap/runtime implementation used by the
  current Star installer. The name is historical; do not delete it as a POC.
- `bay-systemd/`: systemd bay runtime scaffold and upgrade workflow, including
  `upgrade-bay-release.sh`.
- `control-plane-bundle/`: control-plane bundle build helper.

## Active Dev And QA Workflows

- `dev/`: local hub/lite daemons, smoke tests, benchmarks, and personal dev
  helpers.
- `bug-hunt/`: bug-hunting automation and tests.
- `install/`: small dependency installers used by dev/test flows.
- `patches/`: patches consumed by release/build scripts.

## Support Material

- `auth/`: authentication helper scripts.
- `postgresql/`: database maintenance snippets and notes.
- `skel/`: legacy skeleton shell files used as static inputs.

## Legacy Scripts

`legacy/` contains old top-level operational scripts that had no current repo
references during the June 2026 cleanup pass. They are preserved for history,
not advertised as supported workflows.

If you need one of them again, move it into a purpose-specific directory,
update it against current CoCalc, add documentation, and wire it to a package
script or README.

The old `make-user-admin` script was deleted instead of archived because it ran
raw SQL built from an unescaped email address. Use maintained account/admin
APIs or fresh-auth-aware tooling instead.
