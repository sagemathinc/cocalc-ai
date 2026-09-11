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

## Remaining Manual Check

Live browser inspection could not proceed: the previous local browser-test
account sessions have expired, and the supported CLI requires interactive
sign-in. No fresh desktop/mobile screenshots were verified in this pass.
The CPU SSH alias currently fails DNS resolution; that failure is reported
instead of being interpreted as a CPU-only machine.

Discovery is deliberately not a recursive scan of every virtual environment on
disk. Use the additional kernelspec directory for otherwise unregistered kernels.
Fresh environments without Python need explicit preparation of the private
runtime before discovery can inspect remote kernels and hardware.
