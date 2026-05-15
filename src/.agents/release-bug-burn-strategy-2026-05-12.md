# Release Bug Burn Strategy

Status: initial strategy, 2026-05-12.

Goal: make `cocalc-ai` credible for the Thursday 2026-05-14 team checkpoint and
keep the May 31 first-public-release target realistic.

Inputs:

- [first-public-release-scoreboard-2026-05-09.md](./first-public-release-scoreboard-2026-05-09.md)
- [release-security-abuse-audit-plan-2026-05-11.md](./release-security-abuse-audit-plan-2026-05-11.md)
- [release-security-abuse-scoreboard-2026-05-11.md](./release-security-abuse-scoreboard-2026-05-11.md)
- `/home/user/wstein.tasks.md`
- live `lite4b` 3-bay soak findings from 2026-05-12

## Working Model

The first-release feature checklist is effectively closed. The release risk is
now mostly known-bug elimination, security/admission-control audit completion,
and soak-driven polish.

Do not expand product scope during this phase. Every change should be tied to
one of:

- correctness
- data safety
- billing or purchase trust
- auth/security boundary
- operator recovery
- dogfood-visible UX confusion

## Tracks

### Track A: Known Bug Burn-Down

This is the highest-priority track through the May 14 checkpoint.

Rules:

- Reproduce one bug at a time.
- If reproduction is local and root cause is contained, fix and commit.
- If reproduction needs unavailable live state, write a precise bug note and
  move to the next bug.
- Prefer focused tests plus one live smoke when the bug is UI/control-plane
  driven.

### Track B: Security / Abuse Audit

Continue the existing audit, but do not let it starve Track A.

Release-critical audit items:

- preserve the new backend admission-control work
- classify remaining CLI/API-key/registration-token/master-key gaps
- enforce that non-admin dedicated-host creation can never use self-hosted
  project-host mode
- keep browser automation raw-exec disabled by default

### Track C: Soak / Stress

Keep `lite4b` soaking while Track A changes land.

Useful stress:

- 3-bay control-plane probes
- browser reconnect churn
- project start/stop/move churn
- host admin operations
- notification outbox pressure
- hub restart while sessions/projects are active

Avoid:

- unbounded VM creation
- unbounded outbound email
- provider stress that creates uncontrolled cost

### Track D: Launchpad / Bootstrap Polish

This is valuable, but comes after Track A and the release-critical security
checks.

Work here:

- simplify Cloudflare/gcloud setup from
  [self-hosted-provider-bootstrap-ux-2026-05-08.md](./self-hosted-provider-bootstrap-ux-2026-05-08.md)
- run a full SSH-tunnel self-hosted Launchpad smoke without Cloudflare or gcloud
- document the production-safe support boundary

## Priority Order

### P0: Fix Before May 14

1. Host admin bulk project stop is not robust.
   - Symptom: host dialog could not stop some conmon-only projects on `host1`,
     while direct owner stop worked.
   - Release risk: operator UI lies or cannot recover projects.
   - First hypothesis: bulk host project operation is using the wrong authority,
     stale running-state source, or a path that does not use the conmon fallback
     already present in direct project stop.
   - Validation: reproduce on `lite4b`, fix, then stop/restart projects through
     the host dialog or matching CLI/API path.

2. Cross-host project file copy is broken with `/root` path permission error.
   - Symptom: `EACCES: permission denied, realpath '/mnt/cocalc/data/cache/project-roots/.../root/docs'`.
   - Release risk: data movement between hosts is a core trust boundary.
   - First hypothesis: restore/copy path assumes rootfs `/root` instead of the
     project user home path.
   - Validation: copy a small directory between projects on different hosts,
     then benchmark enough to know whether the backup/restore path is acceptable.

3. Jupyter agent-button turns can silently not start.
   - Symptom: pressing the agent button creates chat messages, but no turn runs;
     manual chat works. (This was the install kernel via agent button.)
   - Release risk: visible stuck workflow in a core onboarding path.
   - First hypothesis: expired Codex auth or ACP admission denial is not being
     projected back into the Jupyter/kernel-install agent UI.
   - Validation: force expired auth and confirm the UI shows an actionable auth
     error instead of a silent queued-looking message.

4. Chat live running log drops activity chunks.
   - Symptom: main chat log omits output that is visible in the activity-log
     drawer; browser refresh restores it.
   - Release risk: users lose trust in agents and logs. (very high risk)
   - First hypothesis: live projection/rendering state drops or coalesces
     activity deltas while the persistent activity log is correct.
   - Validation: reproduce with a long streaming turn and confirm main chat log
     matches activity drawer without refresh.

5. Dedicated-host self-hosted mode must be admin-only.
   - Symptom/risk: self-hosted project hosts contain secrets and may allow SSH
     by the host operator; non-admin dedicated-host buyers must not be able to
     create them.
   - Validation: non-admin API/UI attempts to create or select self-hosted
     dedicated hosts are rejected; admin path still works for development.

6. Project appearance title save can close/break the active project tab.
   - Symptom: saving a project title from Settings -> Appearance succeeds on the
     backend, but the frontend removes the open project and leaves the tab
     broken.
   - Release risk: visible dogfood-critical project settings workflow breakage.
   - Status: fixed in `e5819088e1`; needs live confirmation after frontend
     rebuild/restart.

7. Active chat room can stay forever in `Loading...` after project-host restart.
   - Symptom: on `alpha.cocalc.ai`, after rebuilding/upgrading project-host
     components, the active dogfood chatroom stayed stuck indefinitely in a
     full-page `Loading...` state.
   - Related symptom: earlier `lite4.chat` testing showed a tiny forever
     `Loading` state after backend component upgrade.
   - Release risk: routine project-host upgrades/restarts can break active chat
     sessions and require manual close/reopen or refresh.
   - First hypothesis: frontend project/chat reconnect state does not recover
     after project-host websocket/session invalidation, or a stale loading
     promise masks the reconnect/auth failure.
   - Validation: restart a project-host while a chatroom is open; confirm the
     existing tab reconnects, or shows an actionable reconnect/auth error, and
     never remains indefinitely in `Loading...`.

### P1: Fix Before May 31, Pull Forward If Easy

8. Nebius H200 GPU is visible to `nvidia-smi` but not TensorFlow/PyTorch.
   - Symptom: on a Nebius H200 host in the US, `pip install` of TensorFlow and
     PyTorch works and `nvidia-smi` sees the GPU, but Python frameworks do not
     see CUDA devices.
   - Release risk: dedicated GPU trust and first-run GPU usability.
   - First hypothesis: rootfs image CUDA/runtime libraries do not match the
     host driver, or bootstrap is missing the container GPU runtime/device
     exposure required by these wheels.
   - Validation: reproduce on the same H200 rootfs, record `nvidia-smi`, CUDA
     library visibility, `torch.cuda.is_available()`, and TensorFlow GPU device
     listing; distinguish rootfs-image problem from host bootstrap problem.

9. Jupyter kernel selector/add-kernel UX regresses after one kernel exists.
   - Keep an obvious "add/install kernel" path even when kernels already exist.
   - Keep the top Jupyter bar and red no-kernel warning visible when no kernel
     is selected.

10. Notification toast timing is wrong.

   - Toasts should appear when notifications arrive, not when notifications are
     marked read.

11. Backup time display appears random.

- Project storage overview and backup tooltip should use the actual most
  recent relevant backup timestamp.

12. Project quota/memory should be recalculated on stopped-project start.
    - Verify first; this may already be fixed.
    - If stale, make start/restart refresh effective project run quota from the
      current membership/default state.

### P2: After Known Bugs, Before Public Launch If Time Allows

13. Launchpad Cloudflare/gcloud bootstrap UX.
14. Full SSH-tunnel self-hosted Launchpad smoke.
15. Operator runbooks for rollback, host refresh, orphan inspection, and
    self-hosted security boundary.
16. UI/UX polish from end-to-end human testing.

## May 14 Checkpoint Target

By Thursday 2026-05-14, aim to show:

- P0 bugs fixed or reduced to precise documented residual risk.
- `lite4b` 3-bay soak still green after the fixes.
- At least one clean end-to-end demo path:
  - signup/signin/email verification,
  - membership/site license/course pay,
  - project create/start/Jupyter/chat,
  - dedicated host admin/operator recovery smoke.
- Security audit progress summarized with only explicit known residual risks.

## May 31 Release Target

Before first public release:

- all P0/P1 bugs closed or explicitly accepted with mitigation
- release-security-abuse scoreboard has no `unknown` high/critical rows without
  an owner and decision
- self-hosted dedicated-host mode is provably admin-only
- notification/email abuse controls are good enough for hosted launch
- one long `lite4b` soak has no unresolved correctness/trust bugs
- launch docs state the narrow supported provider/SKU/support boundary

## Immediate Next Step

Start with P0 bug 1: host admin bulk project stop.

Reason:

- It was found during the current soak.
- It directly affects operator recovery.
- The system already has conmon fallbacks in some paths, so the likely fix is
  contained.
- It gives fast confidence that the host admin UI can recover from the exact
  class of messy state caused by earlier project-host upgrade bugs.
