# Remote Kernel Implementation Evidence

This records implementation and validation, not blanket production signoff.
See [the plan](remote-jupyter-kernels-plan-2026-09-09.md) and
[operator guide](../../docs/remote-jupyter-kernels.md).

## Implementation

- Reflect branch `feature/remote-jupyter-kernels`, foundation `f6e408b`, lifecycle
  followup `1fc9e94`: conventional kernelspec, five SSH forwards, private remote
  Python supervisor/guardian, prepare/register/status/interrupt/stop/remove,
  cross-process target locks, idempotent launch/cancel, bounded lease cleanup.
- CoCalc branch `feature/remote-jupyter-kernels`: setup/removal UI, existing
  selector integration, graceful proxy shutdown and per-path replacement barrier,
  late-launch cleanup, remote usage exclusion, pinned JS tools bundle, and
  preservation of selected kernels in exports when the catalog cache is absent.
- No remote CoCalc or Jupyter HTTP server. Existing notebook ownership and project
  execution routes are reused. No provider-specific or local-bay DB shortcut.

## Automated And Live Results

| Check                     | Evidence                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reflect unit suite        | 39 files passed, 127 tests passed; 2 files/3 tests skipped and 7 existing todos                                                                                                               |
| Reflect types/lint/bundle | TypeScript build, ESLint, CJS/ESM bundling passed                                                                                                                                             |
| Supervisor failure tests  | Real Python in isolated HOME: cancel-before-start, idempotent retry, changed request rejection, missing interpreter, stale boot, failed-install cleanup/retry                                 |
| CoCalc frontend           | 26 focused tests passed: remote setup/removal, input validation, keyboard focus/Escape, late-result cleanup, selector/status regressions, remote usage                                        |
| CoCalc Jupyter            | 19 focused tests passed: local discovery/execution, proxy stop/barrier, real remote execution/restart, close during startup, process-wide cleanup, nbgrader                                   |
| CoCalc build checks       | Frontend, Jupyter and project typechecks; frontend lint; dependency consistency; static development build passed                                                                              |
| Minimal CPU VM            | Ubuntu 24.04 x86_64; private environment preparation and repeated validation; no remote Node or system package modification                                                                   |
| Standard Jupyter client   | Execute, streams, errors/rich output, completion, inspection, stdin, interrupt, protocol shutdown and manager restart passed                                                                  |
| jupyter console           | 6.6.3 executed on the remote CPU hostname and shut down cleanly                                                                                                                               |
| JupyterLab                | Maintainer independently reported success using this project's JupyterLab                                                                                                                     |
| Concurrent kernels        | Independent state/ports/keys, binary comm buffers, widget initialization, transient tunnel restart passed                                                                                     |
| Failure cleanup           | Launcher SIGKILL/15-second test lease; supervisor SIGKILL; kernel exit(7); target removal; occupied local port and invalid interpreter passed                                                 |
| GPU                       | NVIDIA L40S, driver 580.173.02; final PyTorch 2.8.0+cu128/NumPy recipe; CUDA math and graceful manager restart passed                                                                         |
| CoCalc project GPU        | Actual project Jupyter exec API on lite2b, CUDA 1024x1024 matrix and remote hostname verified                                                                                                 |
| Non-admin account         | Created designated student account and project access; SSH registration and actual CUDA notebook run through that account's CLI profile passed                                                |
| Student browser           | First-party browser authorization; signed-in non-admin registered student-ui-gpu, selected it, and removed the older test target through the actual UI                                        |
| Browser persistence       | Student and operator views shared CUDA array state; after both browser refreshes the same remote PID 182351 remained, with execution count advancing                                          |
| Responsive appearance     | Native Chromium screenshots reviewed at 1280x720 and 393x852; registration, target list and removal confirmation readable in light/dark mode                                                  |
| Notebook export           | 7 new selected-kernel export/import regressions; 21 tests passed with existing language-info/export-import suites                                                                             |
| Additional local kernels  | 43 tests across 7 local/remote kernel suites passed                                                                                                                                           |
| Browser automation        | Fixed React-controlled input typing in a separate commit; 12 action-engine tests passed, including actual controlled input/textarea replacement and append                                    |
| Tools artifacts           | Pinned Reflect source download/hash/build passed; full Linux amd64/arm64 and minimal Linux amd64/arm64 + Darwin arm64 builds passed, including cache restore; JS, wrapper and license present |

Remote integration tests are opt-in so ordinary CI does not need SSH credentials:

```sh
# From src/packages/jupyter, with a registered local test kernelspec:
COCALC_REMOTE_JUPYTER_TEST_KERNEL=reflect-teaching-poc DEBUG= DEBUG_CONSOLE=no \
  pnpm exec jest --runInBand kernel/remote.integration.test.ts
```

Reflect's `scripts/test-jupyter-*.py` provide the independent conventional-client,
GPU, disconnect, removal and crash tests. They create their own synthetic sessions;
they must not be pointed at user session IDs for destructive tests.

## Test Fixtures

- Local CPU SSH alias: `jupyter`; GPU alias: `jupyter-gpu`.
- Validated local GPU target: `gpu-validated`, environment `pytorch-validated`.
- lite2b student: `remote-jupyter-student-20260909@example.com`, account
  `3b969f55-776c-4d32-877a-5e2ac1e881b6`, no admin privileges.
- Student test project: `6ef7fc05-39fe-479b-989c-b2c8ceb0a766`, notebook
  `/home/user/student-gpu-persistence.ipynb`, kernelspec `reflect-student-ui-gpu`.
- Student UI-created target GPU run: `cli-mtuqxxx8-rqjsv8`, cell `f736c0`, verified
  remote hostname and NVIDIA L40S output without the older environment's missing
  NumPy warning. Shared-state cell `a28765` passed in runs `cli-mtuqzd5t-a2h2dt`
  and `cli-mtur1u62-q7596w`, retaining PID 182351 after refresh. This is student
  collaborator execution, not student VM provisioning or billing-policy testing.
- Older target `student-gpu` was removed through the student UI; its original
  notebook is a historical fixture, not the current demonstration notebook.
- The updated project bundle was deployed only to the local dev host and this
  test project was restarted: version `1788996487743`, build identity
  `20260909T232757Z-795e3f932e01-dirty-e1e0ee0c`. No production rollout is claimed.
- The ignored local hub environment designates that account for first-party
  testing-browser authorization. Keys are project-local; only public keys were
  installed in the test VMs' authorized_keys. No credentials belong in this doc.

## Bugs Found During Validation

- Missing/stale catalog data could erase the explicitly selected kernel from a
  notebook export, allowing the account default to replace it on first browser
  open. Export now retains the selected name even without matching catalog data.
  Both export/import tests and a newly created live notebook verified the fix.
- Typed browser automation assigned input.value through React's instance setter,
  updating the visible field but not the form state. The helper now uses native
  input/textarea setters before emitting events; actual student form registration
  succeeded after this fix. Commit `f12a3ac854` isolates the automation change.

## Outstanding Evidence And Limits

- Browser screenshots use Chromium with viewport emulation, not real-device
  Safari validation. Temporary screenshots are under `/tmp/student-remote-*`,
  `/tmp/student-narrow-light.png`, and `/tmp/student-confirm-narrow.png`.
- Actual VM reboot/IP reassignment was not forced because the supplied VMs have
  the maintainer's active notebooks/JupyterLab kernels. Stale boot rejection and
  fresh SSH hostname resolution are implemented; this is not a live reboot test.
- Only the supplied L40S image is GPU-validated. Do not claim separate GCP and
  Nebius image validation without identifying/testing both images.
- The no-Python bootstrap branch and ARM artifact are implemented but not
  validated on bare remote images; the supplied Ubuntu VM already had Python 3.
- Killed installations never publish their temporary environment, but SIGKILL
  may leave an unreferenced temporary version on disk. Ordinary failed installs
  are cleaned and can be retried.
- No lossless output replay, file synchronization, remote RAM/CPU monitoring,
  GPU scheduling, or automatic VM shutdown is claimed.

Keep these fixtures available for the maintainer's review. Later cleanup should
remove the test targets/sessions, project-specific public keys from the VMs,
testing-account designation and browser authorization, then the test project and
account through normal administrative actions. Do not stop unrelated user kernels.
