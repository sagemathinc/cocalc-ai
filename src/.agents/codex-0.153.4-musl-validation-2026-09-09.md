# Patched Codex 0.153.4 musl candidate

Production rollout is deferred to the next reviewed release. This work updates
PR #510 and validates the patched musl pair on staging2.

## Source and builds

- Upstream tag: rust-v0.153.4, commit 3d2ee51ca2d5db578f328aa75e20aa22c0197c9a.
- Both architectures apply the TCP user-timeout patch and a lockfile correction
  that only changes 149 workspace package versions from 0.0.0 to 0.153.4.
- x64 native build: /tmp/codex/build-musl-x64.log.
- ARM64 native build: GitHub Actions run 34321988706, CoCalc-ai repository.
- Output root: /tmp/codex/musl-binaries/0.153.4.
- Candidate release tag: v0.153.4-cocalc-musl-1. Preserve the existing GNU tag.

The first x64 compilation succeeded in 15m44s. Editing the build script while
it was running disrupted its final manifest step; cleanup still left the
upstream checkout clean. A repeat invocation is recorded in
/tmp/codex/build-musl-x64-finalize.log. That repeat succeeded in 12m06s,
left the checkout clean, and produced byte-identical binaries.

The native ARM64 build succeeded in 58m36s. Both ARM64 executables are static;
native CLI startup passed on the runner. Local QEMU checks also passed CLI
startup and V8 JavaScript execution through the companion.

## Initial x64 validation

- Both executables are static PIE and start in an empty chroot without shared
  libraries. CLI reports 0.153.4.
- The code-mode companion successfully executes JavaScript and returns 42.
- App-server goals, normal command tools, explicit compaction, marker recall,
  and active command cancellation pass (43.4s).
- Socket tracing observes TCP_USER_TIMEOUT=300000 with no environment override.
- Astra imagegen succeeds on the previously failing prompt in 60.5s, producing
  a valid 1774x887 RGB PNG. GPT-5.5 succeeds in 51.2s on the same prompt.
  Both are single attempts without retries.
- Logs: /tmp/codex/musl-protocol-smoke.log, /tmp/codex/musl-astra.jsonl,
  /tmp/codex/musl-astra.sockets.

## Staging2 validation

- Tools candidate: 20260909T081257Z-170b699a-20260909-codex-musl.
- Deployment: 20260909T081518Z-20260909T081257Z-170b699a-20260909-codex-musl.
- Rollout succeeded on staging2-shared-1 and staging2-copy-canary.
- Restarted only smoke project d5b7644c-5e6f-482d-9246-b4529868b4c2.
  Its actual CLI and companion hashes match the published x64 musl binaries.
- The tools smoke command passed. Astra generated the previously failing image
  through CoCalc in one attempt, with a completed image event, uploaded blob,
  and final response. The saved file was independently verified as a valid
  1774x887 RGB PNG using project exec.
- Codex session: 01a0853d-8b16-7ea2-8230-99dc131e837d.
- Image: /home/user/.codex/generated_images/01a0853d-8b16-7ea2-8230-99dc131e837d/exec-4d51dc23-8e9d-4cea-aada-06658a136a54.png.
- Staging hosts are x64; ARM64 validation was native runner startup and local
  QEMU CLI/V8 companion execution, not a native ARM64 staging session.

Production was not deployed. Its desired tools version remains
20260909T025724Z-4ed65040-20260908-4ed650408d-codex1534. Publishing tools updates
shared compatibility latest pointers, so both architecture pointers were
explicitly restored to that previous version and verified via their public
JSON catalogs. Staging retains the explicit musl candidate version.

## Publication and installer validation

Published as a prerelease at
https://github.com/sagemathinc/codex/releases/tag/v0.153.4-cocalc-musl-1.
The existing GNU release is preserved. Both architecture pairs were installed
from the real GitHub downloads, with archive and executable hashes verified.
Same-version stock binaries and missing companions are rejected.

Backend typecheck and all 12 focused installer/integrity tests pass. Six
additional release-script tests cover assembly compatibility and corrupt ELF
rejection. Installer pins: commit a6f58594d4 on PR #510; isolated staging
release commit 170b699a37 on release/codex-musl-staging.

## Separate main-branch CI issue

Run 34322476913 passed build and all package test jobs, but failed static checks
on an unsafe finally block at server/cloud/cloudflare-blob-reconcile.ts:422.
That file is from newer main and absent from this PR branch. Local branch lint
passes. Review this separately when assembling the broader release.
