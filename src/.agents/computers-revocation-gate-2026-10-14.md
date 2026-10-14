# Computers: revocation that stops running work (stage-1 release gate)

Implementation note, Oct 14 2026. **Revision 3** answers lite1-review's
re-review of revision 2. Plan: `computers-plan-2026-10-11.md` ("Revocation
semantics", "The computer principal and the data path", "Multi-bay,
rehoming, deletion"). This is the first open release gate from #1036: *the
signed floors/control push and the epoch-close outbox (revocation must also
stop running work)*.

Daemon-side pieces already on `feat/computers-revocation`:
- the signed `computer-control` "end" (c78782b65b), and pushes on the op
  channel;
- the `deleted` reason;
- certificate expiry ending the daemon;
- the policy update (60fc3f9bf8), which is narrow-only against the current
  effective policy and the ceiling (f824ecc768).

`setEffectivePolicy` is refused until delivery exists. Revision 3 folds the
separate kinds into one **state snapshot** (§1). The code follows once this
note is approved.

## Invariants

1. **Every daemon that may be running work applies the computer's current
   state, or ends.** That covers each open session at any epoch, every
   future session, and an offline daemon at its next login attempt.
2. **No operation reaches a session that hasn't applied the current state.**
   Readiness is structural (§3).
3. **Receiving a snapshot grants nothing:** no operation, report or
   subscription authority beyond the exact receipt (§4).
4. **Delivery is at least once.** Applying again is harmless:
   - floors are componentwise maxima;
   - a policy applies only with a newer epoch and only if it narrows;
   - "ended" is terminal.
5. **Only signed state acts.** Unsigned errors (the site switch, outages)
   never end a daemon.
6. **Restrictions need only the home bay's signature.** Floors, a narrowed
   policy and "ended" only ever restrict, so the home bay may decide them
   from its own evidence (§6). Admission keeps requiring the project bay's
   attestation.

## 1. One signed state snapshot

A single new kind, `computer-state`, replaces separate pushes:

```
{ type: "cocalc-computer-state", version: 1, computer_id,
  state_version,                       // the hub's counter for this computer
  home_epoch, computer_epoch,          // floors
  project_floors: { [project_id]: privacy_epoch },   // at most 500 (§5)
  policy_epoch, policy,                // the current effective policy
  ended: null | { reason: "revoked" | "replaced" | "deleted" },
  issued_at }
```

- **Signing.** The home bay signs it with a key the daemon trusts (§4). It
  builds it from typed columns and checks `computer_id`, never stored JSON.
- **Applying.** The daemon verifies it, then applies it **atomically, in
  one durable write**:
  1. floors are merged by maximum;
  2. a policy is applied only if `policy_epoch` is newer and the policy is
     at most the current effective policy and the ceiling;
  3. `ended` comes last: if set, every job is stopped and the connector
     stops.
- **The ack** comes only after the write: `{ ok: true, state_version,
  envelope_hash }`. If verification fails, the ack is `{ ok: false, error }`
  and nothing changes.
- **Replaces earlier kinds.** It supersedes `computer-floors`,
  `computer-control` and `computer-policy` as pushes; their parsers stay for
  the unit tests. `ComputerPush` becomes `{ state }`.

## 2. Durable state at the home bay

All of these are account-home tables carrying `account_id`, added to
`COMPUTER_STATE_TABLES` (rehoming stays blocked while computer state exists).
- **`account_computers`** gets:
  - `state_version` (bigint), bumped by every change below;
  - `ended_reason`, for deletion.

  Every change locks the computer row (`FOR UPDATE`); a login locks it too
  (§3):
  - revoke and tombstone;
  - `bumpComputersForNetwork` and `bumpComputersForAccount`;
  - policy (once enabled);
  - a project floor raise;
  - deletion, which is written inside `markAccountDeleted`'s fenced
    transaction, before `deleted=true`.
- **`account_computer_project_floors`** `(account_id, computer_id,
  project_id, privacy_epoch, updated_at)`: raised only. GC is in §5.
- **`account_computer_session_targets`** `(account_id, computer_id,
  session_id, generation, state_version, reply_subject, claimed_by_hub,
  attempt_token, lease_until, last_error)`:
  - one row per open session, created or raised by the change transaction
    for **every** open session of the computer (`closed_at IS NULL`,
    whatever its epoch);
  - raising it clears `attempt_token`, `lease_until` and the claim.

## 3. Readiness: no operation before the snapshot

- **A session starts not ready.** `account_computer_sessions` gets
  `ready_version` (bigint, null at login).
- **Ordinary authority requires readiness.** `currentSession()`, the relay
  commit and `sessionIsCurrent()` all require
  `ready_version >= account_computers.state_version`.
- **Two capabilities before ready:**
  - the subscription to its own op subject;
  - the exact snapshot receipt (§4).
- **Login.** The login transaction locks the computer row, inserts the
  session (`ready_version` null) and its target at the current
  `state_version`.
- **Every state change** locks the same row, bumps `state_version`, and
  raises the targets of all open sessions. A login can't miss an
  enumeration, and a session can't believe an old version is enough.
- **Promotion** happens only through the finalize CAS (§4):
  `ready_version := acked version`. If the state moved on meanwhile, the
  session stays not ready until the newer target is acked.

## 4. Delivery, receipt and keys

- **Claim.** `UPDATE targets SET attempt_token=$new, claimed_by_hub=$me,
  lease_until=now()+30s, reply_subject=$exact WHERE ... AND (lease_until IS
  NULL OR lease_until < now()) RETURNING`, then commit. No lock is held
  across I/O. Here `$exact` is
  `hub.computer.<id>.reply.v1.<session>.<me>.<attempt_token>`.
- **Publish** the signed snapshot on `computer.<id>.<session>.op.v1`,
  `{ v: 1, correlation: attempt_token, reply_subject: $exact, push: {
  state } }`, and wait for the ack.
- **The ack is parsed strictly.** `ok: true`, with `state_version` and
  `envelope_hash` equal to what was sent, finalizes:
  - `UPDATE targets ... WHERE attempt_token=$t AND state_version=$v`;
  - then the session's `ready_version`, by CAS.

  `ok: false` never finalizes; it records `last_error` and backs off.
- **The receipt grace path.** `isComputerAllowed` keeps refusing a stale or
  not-ready session, with one exception: publishing to exactly the
  `reply_subject` of a target with an unexpired lease, the same `session_id`
  and `generation`, and `claimed_by_hub`. That is the only pre-ready or
  post-bump capability.
- **A closed session.** The router's revalidation still closes stale
  sessions. A target whose session closed is deleted. Its daemon logs in
  again (and gets the snapshot as its first message, before any operation),
  or is answered "ended" at the challenge.
- **Ended at the challenge, offline or with the switch off.**
  - The challenge endpoint first verifies the exact signed challenge request
    against the stored key and its bindings: site, cluster, home, account,
    computer. This holds for revoked, tombstoned and deleted computers too.
  - For an ended computer it answers `{ state: <signed snapshot with ended>,
    keys }`, **before** `assertComputersEnabled`.
  - `keys` is the home bay's key chain with `signing-key-endorsement`
    envelopes. The daemon trusts a new key only through an endorsement by a
    key it already trusts, of the same bay. So a computer offline across a
    rotation still verifies "ended".
  - Computer rows and keys are kept until the certificate's `not_after`.

## 5. Bounded project floors

- **`account_computer_active_projects`** `(account_id, computer_id,
  project_id, possibly_active_until, next_check_at, lease_until,
  claimed_by_hub)` is written by the ticket transaction:
  - a run: open-ended until reports exist (gate 3);
  - an exec: issue time plus 1 h plus a margin;
  - put/get: the stream's maximum.
- **An admission bound keeps the snapshot bounded.** A ticket for a new
  project is refused while the computer has 500 possibly-active projects
  ("this computer is serving too many projects at once").
- **GC is safe.** A project floor row and its active row are deleted once
  both of these have passed:
  - `possibly_active_until`;
  - the last ticket's `start_by` for that project.

  After that, no job, stream or admissible ticket of that project can
  exist on that computer, so the floor has nothing left to stop. The
  daemon's own floors map only grows, and that's harmless. Test: 1001
  lifetime projects across reconnects.

## 6. Project ineligibility, every kind

- **Soft delete and undelete bump the epoch.** The trigger bumps
  `runtime_authority_revision` on `UPDATE OF users, deleted`, so they get a
  new epoch like a collaborator change. (Today it fires on `users` only.)
  - Eligibility is a function of the row at a revision. An ineligible
    attestation at epoch `e` means no ticket at `e` was ever valid, so the
    floor is `e`.
  - Undelete bumps again, so later tickets sit above that floor.
- **Hard delete raises a terminal floor.** Re-attestation then finds no
  project: the bay directory has no owner, or the owning bay answers
  definitively "no such project". The home bay sets the floor to
  `TERMINAL` (`2^53 - 1`) and signs it in the next snapshot (invariant 6).
  Project ids are UUIDs and never reused. Transient errors only retry.
- **The poller** is a due-work queue:
  - hubs continuously claim due rows (`next_check_at <= now()`, lease,
    `SKIP LOCKED`, 50 per claim);
  - at most 8 attestations in flight per hub, each with a 10 s timeout;
  - it verifies each returned attestation's signature and bindings:
    project, account, attesting bay;
  - it reschedules `next_check_at` to 30 s after success, or later with
    backoff after an error.
- **Worst-case latency, documented:** detection is
  `due rows / (hubs × 8 / mean attestation time)` plus delivery. With the
  admission bound (500 per computer) and the queue, a backlog drains
  instead of growing. The 30 s attestation lease only bounds new admission.

## 7. Certificates

**Pending William's decision** (asked Oct 14):
- **(a)** stage 1 gives computers without a time limit a 1-year
  certificate. They must pair again after it, and Settings → Computers
  shows the expiry. Renewal comes later.
- **(b)** a renewal rollover protocol now:
  - keep the current and prior certificates, and accept either at login
    through the prior one's `not_after`;
  - the renewed payload equals the current one except `not_after` and
    `not_before`, with a bounded lifetime;
  - never renew ended or time-limited computers.

Either way, the daemon ends at its own certificate's `not_after`. That is
already implemented.

## 8. The revocation table, row by row

| Action | This gate |
|---|---|
| Revoke / disconnect | `ended: revoked` to every session; ended at the challenge |
| Re-pair (tombstone) | `ended: replaced` |
| Account deleted | `ended: deleted`, written in `markAccountDeleted`'s transaction |
| Network narrowed, account paused | computer floor: queued work cancelled, running continues (documented) |
| Project ineligible (collaborator, soft delete) | project floor at the new epoch: its queued and running work stopped |
| Project hard-deleted | terminal project floor |
| Effective policy narrowed | policy in the snapshot (enabled with this gate): queued work with the old epoch cancelled |
| Time limit | local (exists) |
| Per-agent stop | deferred: no per-agent grants beyond network membership in stage 1 |

## 9. Tests

- **e2e, with a real conat server and connector:**
  - revoke during a running job, with one session and with two simultaneous
    sessions: every session acks through the grace path, and every job is
    killed;
  - revoke while offline, with the site switch off, and across a key
    rotation;
  - account deletion, connected and offline;
  - a collaborator added, a soft delete and a hard delete, during a run and
    during a 50-minute exec: killed within one poll; other projects
    continue; an undelete admits new tickets again;
  - **the initial session:** an operation relayed before the first snapshot
    is acked is refused;
  - a login racing each kind of bump, and a relay racing initial delivery;
  - an ack lost after application: redelivery is harmless; a stale
    attempt's or another hub's ack can't finalize; `ok: false` never
    finalizes;
  - the grace path refuses everything but the exact reply subject;
  - 1001 lifetime projects across reconnects;
  - more than 200 due pairs, and a slow or unavailable project bay.
- **Unit tests:**
  - the snapshot is applied atomically, `ended` last;
  - the policy narrows only;
  - endorsement chains (an unknown or other-bay endorser is refused);
  - targets: same-transaction writes, lease and claim under concurrent
    hubs, readiness promotion only by CAS.
