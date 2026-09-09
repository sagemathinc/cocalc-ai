# CoCalc Scripts

This directory is for repository-level operator and developer scripts.

Keep new scripts in a named subdirectory with a README unless there is a strong
reason for a top-level entry point. Top-level scripts should be actively used,
documented, or referenced from code.

## Top-Level Entry Points

- `build-local-codex-binaries.sh`: build upstream Codex binaries locally or
  for one native Linux architecture.
- `publish-local-codex-binaries.sh`: publish Codex binary assets.
- `check_doc_urls.py` and `check_doc_urls.skip`: documentation/link checker.
- `export-api-doc.ts`: export API documentation JSON.
- `run-ci.sh`: local full clean/build/test helper.

`build-local-codex-binaries.sh` builds both Linux architectures by default.
Set `CODEX_BUILD_PLATFORM=linux-x64` or `linux-arm64` to build only that
architecture natively. The local build defaults to Codex 0.153.4 with the
version-specific Linux TCP user-timeout patch in `patches/`. This restores the
shared HTTP client's 300-second socket timeout, configurable with
`CODEX_TCP_USER_TIMEOUT_MS` (a positive number of milliseconds). It is not a
total HTTP request deadline or an app-server notification timeout. Changes to
remote compaction deadlines do not establish that this transport mitigation
is unnecessary for other endpoints, including image generation.

The build manifest identifies the applied patch. Building or publishing a
candidate does not change the sandbox installer pin or deploy it. Validate
image generation and compaction before promoting a candidate; normal installs
continue using the assets explicitly pinned in `backend/sandbox/install.ts`.

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
