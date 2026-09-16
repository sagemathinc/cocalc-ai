# Remote Jupyter Discovery Validation

Follow-up to the remote-kernel implementation and draft PRs CoCalc-ai #519 and
reflect-sync #2.

## Implemented

- SSH aliases from project config and Includes, plus a typed destination.
- SSH-first configuration gating and stale-probe protection.
- Read-only remote kernelspec, managed-environment and GPU discovery.
- Existing kernels of any language, Python preparation, and confirmed-GPU
  PyTorch preparation. Advanced retains explicit names/interpreter/recipe and
  adds an extra kernelspec directory.
- Available local names, exclusive registration, and compatible environment
  reuse without overwriting unknown environments.
- Generic kernelspec argv/env/resource directory and interrupt-mode support.

## Verification

- Reflect unit suite: 137 passing tests; 3 skipped and 7 todo remain.
- Focused frontend suites: 16 passing tests, including keyboard focus, Escape,
  SSH errors, stale probes, generic selection and retained advanced settings.
- Focused Jupyter interruption/lifecycle suites: 6 passing tests.
- Frontend TypeScript build, frontend lint, Reflect build/lint and JS bundle pass.
- Static development build passes.
- Live GPU SSH probe identifies the NVIDIA L40S with driver 580.173.02 and
  discovers multiple existing Python environments.
- Separately installed Bash kernel discovered via an extra search directory.
  A standard Jupyter client passes execution, interruption, reuse and restart.
- Existing managed Python kernelspec registered through the generic path passes
  execution, completion, inspection, stdin, rich output, errors, interrupt and
  restart. This caught a virtual-environment prefix-resolution bug, now covered
  by a regression test.
- CUDA matrix multiplication succeeds before and after restarting that generic
  Python kernel, with PyTorch 2.8.0+cu128 on the L40S.

## Fresh Browser Verification (September 11)

Resolved the expired test-browser sign-in using supported CLI dev elevation
and a newly issued dedicated testing-account browser session. The operator's
public-site CLI login was still valid; only fresh-auth elevation had expired.
No password reset, manual cookie copying, or auth-policy bypass was needed.

From `src`, the working operator bootstrap was:

```bash
eval "$(pnpm -s dev:hub:env)"
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" \
  --profile remote-jupyter-public --api https://lite2b.cocalc.ai \
  auth elevate --dev
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" \
  --profile remote-jupyter-public --api https://lite2b.cocalc.ai \
  browser session spawn --target-url https://lite2b.cocalc.ai/static/app.html \
  --project-id 6ef7fc05-39fe-479b-989c-b2c8ceb0a766 \
  --testing-account 3b969f55-776c-4d32-877a-5e2ac1e881b6
```

Use the returned testing profile and exact browser ID for subsequent actions.
Opening the app shell, then loading the full workspace before opening the
notebook, avoided the lazy project-runtime error on first open. A loopback
browser authenticated successfully but repeatedly failed project-host cookie
authentication against the public HTTPS host; using the public site for both
the CLI profile and browser resolved that separate connection issue.

The host had the latest tools installed, but the running validation project
still mounted the September 9 bundle. Restarted only that fixture project to
pick up the new tools. Moved its old proof-of-concept `~/.local/bin/reflect`
wrapper to `reflect.pre-bundle-validation`, so `reflect` now resolves to the
shipped `/opt/cocalc/bin2/reflect`, not the obsolete private override.

Verified through the freshly built UI:

- Initial dialog exposes only the SSH destination and connection action.
- The obsolete `gpu` alias fails public-key authentication and blocks setup.
  The current `jupyter-gpu` alias connects and discovers the L40S and four
  existing Python kernels.
- GPU creation is the default suggestion; Advanced shows the available local
  name `jupyter-gpu-2` and the derived environment name.
- Adding the existing Bash fixture's kernelspec directory and refreshing
  discovery exposes Bash alongside Python kernels; Bash can be selected.
- Native Chromium screenshots at 1280x900 and 393x852 show readable,
  unclipped guided-dialog layouts in light and dark modes. The SSH controls
  and hardware description wrap at phone width.

Screenshots are local artifacts under `/tmp`: `remote-gpu-light.png`,
`remote-advanced-light.png`, `remote-kernel-list.png`,
`remote-mobile-light.png`, `remote-bash-dark-desktop.png`, and
`remote-bash-dark-mobile.png`.

This pass did not submit another environment installation, change notebook
contents, or rerun GPU execution. It is Chromium viewport testing, not a fresh
physical-iPhone/Safari test. Untargeted CLI Escape actions timed out, so this
pass does not add live keyboard-closure evidence to the existing unit coverage;
the visible close controls worked.

## Remaining Scope

The CPU SSH alias currently fails DNS resolution; that failure is reported
instead of being interpreted as a CPU-only machine.

Discovery is deliberately not a recursive scan of every virtual environment on
disk. Use the additional kernelspec directory for otherwise unregistered kernels.
Fresh environments without Python need explicit preparation of the private
runtime before discovery can inspect remote kernels and hardware.
