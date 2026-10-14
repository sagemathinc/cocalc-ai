# Computers: revocation that stops running work (stage-1 release gate)

Implementation note, Oct 14 2026. **Revision 4** answers lite1-review's
review of revision 3. Revision 3 answered the re-review of revision 2. Plan: `computers-plan-2026-10-11.md` ("Revocation
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
- **The daemon reconciles, it doesn't react.** Applying state and
  enforcing it are separate, idempotent steps. After **every** application
  (a first delivery or a replay), and **at every daemon start**, the daemon
  reconciles all queued and running jobs against its durable state:
  - `ended` (persisted as terminal state): refuse all work, and re-drive
    `killAll` before any reconnect or admission;
  - project floors: cancel or kill every job whose authorization is below
    its project's floor;
  - policy epoch: cancel queued work authorized under an older epoch.

  Kill and cancel requests are recorded durably by the existing job and
  cleanup machinery before anything else happens. A crash between the state
  write and a side effect is repaired by the next replay or start, so a
  replay that "raises nothing" still enforces.
- The ack comes only after the write **and** the reconciliation have been
  recorded: `{ ok: true, state_version, envelope_hash }`.
- **`state_version` on the wire** is a decimal string (PostgreSQL bigint),
  compared exactly as a string. It never passes through a JS number. If verification fails, the ack is `{ ok: false, error }`
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
- **Promotion** is one transaction with finalization (§4). It locks the
  computer row, then, only while `account_computers.state_version = acked
  state_version`, deletes the exact target (session, generation, token) and
  sets that session's `ready_version`. Otherwise it changes nothing, and the
  newer target stays pending.
- **A not-ready session isn't closed for lagging.** Router revalidation
  keeps closing a session for its epoch, `closed_at`, lease or deadline, but
  not because `ready_version` lags before delivery. The pre-ready session
  keeps only its op subscription and the exact receipt, for its own
  `session_id` and `generation`.

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
  `envelope_hash` equal to what was sent, finalizes in the single
  transaction described in §3: target and readiness together, only while the
  computer's `state_version` still equals the acked one. `ok: false` never
  finalizes; it records `last_error` and backs off.
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
    envelopes. The daemon validates the chain **historically**:
    - each endorsement was issued by the same bay's predecessor key, while
      that predecessor was valid (`issued_at` within the predecessor's
      `not_before`..`not_after`), in increasing order;
    - the chain starts at a key the daemon trusts (even one that has since
      expired);
    - it ends at a currently valid key.

    The result is used **only** to verify a terminal `ended` state. Expired
    keys are never revived for tickets, floors or policy. So a computer
    offline across a rotation, even past its old key's `not_after` (keys
    rotate at 300 days and expire at 365), still verifies "ended". Test:
    pair just before a rotation, stay offline past the old key's expiry,
    then verify a signed ended snapshot.
  - Computer rows and keys are kept until the certificate's `not_after`.

## 5. Bounded project floors

- **`account_computer_active_projects`** `(account_id, computer_id,
  project_id, possibly_active_until, next_check_at, lease_until,
  claimed_by_hub)` is written by the ticket transaction:
  - a run: open-ended until reports exist (gate 3);
  - an exec: issue time plus 1 h plus a margin;
  - put/get: the stream's maximum.
- **The exact margin invariant:** `possibly_active_until` is at least the
  ticket's `start_by` (the last moment it can be admitted) plus the
  operation's maximum execution or stream lifetime, plus clock skew.
  Examples: exec, `start_by` + 1 h + 5 min; put/get, `start_by` + the
  maximum stream duration + 5 min.
- **An admission bound keeps the snapshot bounded.** A ticket for a new
  project is refused while the computer has 500 possibly-active projects
  ("this computer is serving too many projects at once").
- **Runs, until gate 3.** A run is open-ended until computer→hub reports
  exist (gate 3, also a release gate). So until then, a computer can serve
  at most **500 distinct projects with runs over its lifetime**. This gate
  accepts and documents that cap; gate 3's run-ended reports make run rows
  eligible for GC. The "1001 lifetime projects" test uses exec only, plus a
  separate test of the 500 run-project cap.
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
- **Hard delete raises a terminal floor, only on evidence.**
  `TERMINAL` (`2^53 - 1`) is irreversible, so it's raised only on
  authenticated, durable evidence: the owning bay's hard-delete tombstone
  (`deleted_projects`, written by `server/projects/hard-delete.ts`). The
  project bay answers re-attestation for a tombstoned project with a signed
  `deleted` attestation that binds the project, the account, the bay and
  `deleted_at`. Only that raises `TERMINAL`. All of these just retry:
  - an unknown owner, or a routing failure;
  - a plain missing projects row (a rehome in progress, a stale directory);
  - the rollbacks in `create.ts`, which delete a project that never had
    tickets.

  Test: a directory miss or rehome race, against a real hard-delete
  tombstone.
- **The poller** is a due-work queue:
  - hubs continuously claim due rows (`next_check_at <= now()`, lease,
    `SKIP LOCKED`, 50 per claim);
  - at most 8 attestations in flight per hub, each with a 10 s timeout;
  - it verifies each returned attestation's signature and bindings:
    project, account, attesting bay;
  - it reschedules `next_check_at` to 30 s after success, or later with
    backoff after an error.
- **Worst-case latency, documented, not promised:** detection is
  `due rows / (hubs × 8 / mean attestation time)` plus delivery. The bound
  is per computer, so global due rows can grow. At the 10 s timeout, the
  worst case is 0.8 attestations per second per hub.
  - **Observability:** an operational metric exports the age of the oldest
    due row (queue age), with an admin alert above 5 minutes.
  - **"Within one poll"** is asserted only in bounded test fixtures.
  - If a release latency target is set later, capacity or admission must
    enforce it.
  - The 30 s attestation lease only bounds new admission.

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
  - **crash points:** after the state save, before each side effect, and
    before the ack; then reopen and replay or start: every job that should
    stop is stopped;
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
