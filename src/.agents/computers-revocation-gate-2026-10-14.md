# Computers: revocation that stops running work (stage-1 release gate)

Implementation note, Oct 14 2026. **Approved for implementation by
lite1-review at revision 6** (the certificate option in §7 is William's).
Revision 6 answers lite1-review's
review of revision 5 (its one remaining gap: a rehome immediately followed by
a hard delete). Earlier revisions answered the earlier reviews. Plan: `computers-plan-2026-10-11.md` ("Revocation
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

  - **Foreground `exec` too, not just JobManager jobs:**
    - each exec's full authorization vector (`computer_epoch`,
      `privacy_epoch` with `source_project_id`, `policy_epoch`) is persisted
      in its ledger entry before the release handshake, and kept in the
      in-memory running record;
    - reconciliation decides each exec on its own vector. It kills only
      execs below their project's floor, so an exec admitted later, above an
      already-persisted floor, keeps running;
    - for an affected live exec, its verified-pid cleanup is durably added
      or marked before any abort or signal, and before the ack;
    - at restart, a terminal `ended` still kills everything.

  Kill and cancel requests are recorded durably by the existing job and
  cleanup machinery before anything else happens. A crash between the state
  write and a side effect is repaired by the next replay or start, so a
  replay that "raises nothing" still enforces.
- The ack comes only after the write **and** the reconciliation have been
  recorded: `{ ok: true, state_version, envelope_hash }`.
- **`state_version` on the wire** is a canonical decimal string (PostgreSQL
  bigint): it must match `^(0|[1-9][0-9]*)$`, with no sign and no leading
  zeros, and is compared exactly as a string. It never passes through a JS
  number. If verification fails, the ack is `{ ok: false, error }`
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
  - **A key the daemon still trusts signs it; no historical chains.** A
    certificate never outlives the bay key that signed it: `not_after` is
    at most that key's `not_after`, enforced when the certificate is issued
    (and at any renewal, §7).
    - The `ended` answer is signed with the **certificate's own issuing
      key**. The hub keeps that private key until its `not_after`, which is
      never before the certificate's.
    - So any computer that can still ask (its certificate is unexpired)
      verifies "ended" with a key from its pairing directory.
    - A computer offline past its certificate ends itself locally, at
      `not_after` (implemented). No expired key is ever trusted, and no
      `issued_at` has to be believed.
    - Test: pair just before a rotation, stay offline until after the
      rotation (but within the certificate), then verify ended; past the
      certificate, the daemon has already ended itself.
  - Computer rows and keys are kept until the certificate's `not_after`.

## 5. Bounded project floors

- **`account_computer_active_projects`** `(account_id, computer_id,
  project_id, possibly_active_until, last_attesting_bay_id, next_check_at,
  lease_until, claimed_by_hub)` is written by the ticket transaction (from
  the verified attestation's bay), and `last_attesting_bay_id` is updated on
  each verified eligible poll:
  - a run: open-ended until reports exist (gate 3);
  - an exec: issue time plus 1 h plus a margin;
  - put/get: the stream's maximum.
- **The exact margin invariant:** `possibly_active_until` is at least the
  ticket's `start_by` (the last moment it can be admitted) plus the
  operation's maximum execution or stream lifetime, plus clock skew.
  Examples: exec, `start_by` + 1 h + 5 min; put/get, `start_by` + the
  maximum stream duration + 5 min.
- **An admission bound keeps the snapshot bounded, exactly.** The bound
  is over the snapshot's own set: the union of possibly-active pairs and
  project floors not yet eligible for GC.
  - Under the per-computer serialization (the computer row lock, §3), the
    ticket transaction and snapshot construction first **synchronously**
    delete or filter safely expired pairs: past both
    `possibly_active_until` and the last `start_by`.
  - Only then does the ticket transaction count.
  - A ticket for a project outside that set is refused while the set has
    500 entries ("this computer is serving too many projects at once"). So
    a snapshot never carries more than 500 project floors, whatever the
    asynchronous GC is doing.
  - Test: 500 floor-bearing expired exec projects with GC delayed, then 500
    new active projects, then an initial-session snapshot.
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

  **Which bay to ask:** the active row's `last_attesting_bay_id`. When
  directory resolution has no owner (after a hard delete the directory entry
  may be gone), the poller asks only that last verified bay for hard-delete
  evidence:
  - the actual last owner signs its tombstone;
  - a bay the project moved away from answers "unknown", which just retries.

- **When the last bay doesn't have it either:** a rehome followed at once
  by a hard delete leaves the row naming the old bay, which answers
  "unknown" forever.
  - For a row whose directory resolution is empty **and** whose last bay
    answers "unknown", the poller asks for tombstone evidence through the
    **same bounded, configured-cluster lookup the directory already uses on
    a miss** (`resolveProjectBayAcrossCluster`). Each bay answers from its
    durable `deleted_projects` tombstone.
  - That lookup goes only over the authenticated inter-bay fabric, only to
    the configured cluster bays, only for such rows, and with backoff (every
    5 minutes, then slower).
  - It isn't an open broadcast: only the bay that actually hard-deleted the
    project can return a signed `deleted` attestation bound to the project,
    the account and itself. Every other bay answers "unknown", and that never
    raises anything.
  - When the cluster gets a real cluster-wide project index (the
    directory's own documented long-term fix), the tombstone moves into it
    and this fanout goes away.
  - **Implementation (lite1-review, on approval):** a separately typed
    `resolveProjectHardDeleteEvidenceAcrossCluster`, patterned on the
    configured-bay enumeration, never `resolveProjectBayAcrossCluster`'s live
    result. The caller verifies each envelope's project, account, bay and
    key bindings, and aggregates conservatively:
    - "unknown" is inert;
    - malformed or conflicting signed answers fail closed and raise an
      alert;
    - transport failures retry;
    - only a valid signed `deleted` tombstone raises TERMINAL.

  Tests:
  - a hard delete after the directory entry is already removed;
  - the exact sequence: an old-bay ticket and run, a rehome, an immediate
    hard delete, the directory removed, with no ticket or poll in between.
    TERMINAL must reach the daemon and the run must be killed;
  - a rehome where the old bay answers "unknown" and the project is still
    alive: nothing is raised;
  - a directory miss or rehome race against a real tombstone;
  - one bay unreachable during the fanout: a retry, never a false TERMINAL.
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

**William chose (a) on Oct 14:** "1-year certificate, pair again after;
renewal later". With §4's rule, that means up to a year: a computer without a
time limit gets a certificate until `min(issue + 365 days, signing key's
not_after)`. Settings → Computers shows the date, and the computer must be
paired again after it. Renewal is a later stage. The options, as asked:
- **(a)** stage 1 gives computers without a time limit a 1-year
  certificate. They must pair again after it, and Settings → Computers
  shows the expiry. Renewal comes later.
- **(b)** a renewal rollover protocol now:
  - keep the current and prior certificates, and accept either at login
    through the prior one's `not_after`;
  - the renewed payload equals the current one except `not_after` and
    `not_before`, with a bounded lifetime;
  - never renew ended or time-limited computers.

Either way, the daemon ends at its own certificate's `not_after` (already
implemented), and a certificate's `not_after` is at most its signing key's
`not_after` (§4). Bay keys rotate at 300 days and expire at 365, so a
certificate issued just before a rotation can't last a full year. Option (a)
therefore means "as long as the signing key allows, up to a year", or
longer-lived bay keys. Option (b) renews only over a live session; the
renewed certificate is signed by the current key, and the new directory
comes with it.

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
    before the ack; then reopen and replay or start: every job **and every
    foreground exec** that should stop is stopped. This includes a 50-minute
    exec, and the replay of an old snapshot while a newer-authorized exec
    runs (it keeps running);
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
