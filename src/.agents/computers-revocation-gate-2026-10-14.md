# Computers: revocation that stops running work (stage-1 release gate)

Implementation note, Oct 14 2026, **revision 2**: answers lite1-review's
review of 321bf7e5d3. Plan: `computers-plan-2026-10-11.md` ("Revocation
semantics", "The computer principal and the data path", "Multi-bay,
rehoming, deletion"). This is the first open release gate from #1036: *the
signed floors/control push and the epoch-close outbox (revocation must also
stop running work)*.

## What exists (main at cf65310d75, plus c78782b65b on this branch)

- **What withdraws authority today.** Every withdrawal bumps
  `account_computers.epoch`, in one of four transactions:
  - `revokeComputer`;
  - the tombstone when a computer is paired again (`requests.ts`);
  - `bumpComputersForNetwork` (a member removed, a network paused or closed);
  - `bumpComputersForAccount` (account pause, or revoke-all).

  `setEffectivePolicy` bumps `policy_epoch`. Nothing ever sends the daemon
  the new policy, so its tickets would all be refused afterwards (no UI calls
  it yet).
- **Sessions.** The router revalidates each computer session every 15 s and
  closes it after an epoch bump. `currentSession()` and `sessionIsCurrent()`
  accept only a session at the computer's current epoch.
- **The daemon:**
  - `applyFloors` (pushed floors);
  - `endSession`;
  - since c78782b65b, `applyControl`, which verifies a signed
    `computer-control` "end" and stops every job;
  - pushes ride on the op channel and are acknowledged on the reply subject.
- **The hub has `signing-key-endorsement`.** Each new bay key is endorsed by
  its predecessor. The daemon takes a directory only from its authenticated
  channel (`applyDirectory`, newer generation only).

## Invariants

1. **Every daemon that could be running work for a computer applies every
   push, or ends.** "Every" includes:
   - each pre-bump session;
   - any future session of that computer;
   - a daemon that is offline today.
2. **A push gives a session nothing.** Its receipt grants no operation,
   report or subscription authority after a bump.
3. **Delivery is at least once.** Applying a push again is harmless:
   - floors are componentwise maxima;
   - a policy applies only if its epoch is newer;
   - "end" is permanent.
4. **Only signed pushes act.** Unsigned errors (the site switch, outages,
   rate limits) never end a daemon.

## 1. Pushes

Three signed kinds, all signed by the home bay with a key the daemon can
trust:
- **`computer-floors`** (exists): `{ computer_id, home_epoch,
  computer_epoch, projects: { [project_id]: privacy_epoch }, issued_at }`.
- **`computer-control`** (in c78782b65b): `{ computer_id, action: "end",
  reason, issued_at }`, with reason one of:
  - `revoked`: disconnected by the owner, or revoke-all;
  - `replaced`: tombstoned when paired again;
  - `deleted`: the account was deleted (new).
- **`computer-policy`** (new; this answers MEDIUM 1): `{ computer_id,
  policy_epoch, policy, issued_at }`. The daemon applies it only if:
  - `policy_epoch` is greater than its own;
  - the policy is within its local ceiling P0 (the existing partial order).

  It then sets `effective_policy` and `policy_epoch` durably. Queued work
  with an older policy epoch is cancelled; running jobs continue, as the
  plan documents. `setEffectivePolicy` stays refused (it returns a clear
  error) until this lands, so main never has an effective-policy change
  that can't reach the daemon.

The hub builds every payload from typed columns and checks `computer_id`
before signing, never from stored JSON.

## 2. Durable state, not one message per change

The hub keeps, per computer, **what every daemon of it must have applied**.
It is the source of every push:
- `account_computers.epoch` (exists): computer floor;
- `account_computers.policy_epoch` and `effective_policy` (exist);
- **`account_computer_project_floors`** (new; computer_id, project_id,
  privacy_epoch, updated_at): project floors, raised only, never lowered;
- **ended**: `revoked_at`, `tombstoned_at`, and the account's deletion.
  Deletion writes `ended_reason = 'deleted'` on each computer (new column)
  inside `markAccountDeleted`'s fenced transaction, before `deleted=true`
  makes account authority unavailable (HIGH 2).

A push to any daemon is "the current snapshot of that state", signed now. So
coalescing is automatic: there are no superseded rows, and no componentwise
merges of stored pushes (MEDIUM 3).

## 3. Delivery targets: every session, then every future session

- **`account_computer_push_targets`** (new): `(computer_id, session_id,
  generation, state_version, attempt_token, lease_until, acked_at,
  last_error)`.
  - `state_version` is a counter on the computer, bumped by every change in
    §2: epoch, policy epoch, project floor, ended.
  - A change, inside the same transaction, inserts or raises a target for
    **every open session of the computer** (`closed_at IS NULL`, whatever
    its epoch). `currentSession()` is not used (HIGH 1).
- **Delivery** (any hub process):
  1. **Claim** a target with a short lease and a fresh `attempt_token`
     (`UPDATE ... RETURNING`), then commit. No lock is held across I/O
     (MEDIUM 3).
  2. **Read** the snapshot and sign it.
  3. **Publish** on `computer.<id>.<session>.op.v1` with `correlation =
     attempt_token`.
  4. **Wait** for the ack.
  5. **Finalize** with `UPDATE ... WHERE attempt_token = $1 AND
     state_version = $2`. A stale ack can't complete a newer version.
- **The receipt grace path** (HIGH 1). `isComputerAllowed` keeps refusing
  everything a stale or revoked session publishes, with one exception: a
  publication to exactly `computer.<id>.<session>.reply.<hub>.<correlation>`
  where an unexpired target row matches all of:
  - this exact `session_id`;
  - this exact `generation`;
  - this exact `attempt_token`.

  That grants the single ack and nothing else: no operations, no reports, no
  other subject. Revalidation still closes the socket; the grace path only
  covers the window before that.
- **When a target is done:** when it is acked at its `state_version`, or
  when its session is closed (`closed_at` is set). A closed session's daemon
  either:
  - logs in again, and every new session gets the full snapshot as its first
    message, delivered and acknowledged the same way, before any operation
    is relayed; or
  - is refused at the challenge (§4).

  So a lost push is healed by reconnect, and two simultaneous sessions are
  each served.

## 4. A computer that is ended, while it is offline or the site is off

- **The challenge endpoint verifies first.** It verifies the exact
  challenge-request envelope against the stored computer key, before
  anything else:
  - site, cluster, home bay, account and computer bindings, as today;
  - the check holds for revoked, tombstoned and deleted computers.
- **For an ended computer** it answers `{ ended: <signed computer-control>,
  keys: [...] }`, where `keys` carries the home bay's key chain with its
  `signing-key-endorsement` envelopes. A daemon that knows only its pairing
  directory can still verify a key that has been rotated since (MEDIUM 2).
  - The daemon accepts a new key only through an endorsement by a key it
    already trusts, of the same bay.
  - It then verifies "end", stops every job, and the connector stops.
- **This happens before `assertComputersEnabled`.** A computer revoked while
  the site switch is off still learns that it is ended (HIGH 2). Live
  computers keep getting the "Computers are turned off" error.
- **Retention:** the computer row, key and ended state are kept until the
  certificate's `not_after`, so the answer can be signed and its request
  verified.
- **Backstop:** once the certificate has expired, the daemon treats that as
  terminal. Its tick ends the session (killing every job) at `not_after`,
  so a purged computer can't retry forever (HIGH 2).

## 5. A project that stops being private

- **The project floor.** The home bay re-attests the projects that may have
  active work on a computer, and raises that computer's project floor when
  the project's privacy epoch rises.
- **"May have active work"** is a durable index (HIGH 3):
  `account_computer_active_projects (computer_id, project_id,
  possibly_active_until)`, upserted by the ticket transaction itself:
  - a run: `infinity` until reports exist (gate 3 will clear it);
  - an exec: issue time plus its maximum runtime (1 h) plus a margin;
  - future put/get: the stream's maximum duration.
- **The poller.** Every 30 s it takes a bounded batch:
  - at most 200 (computer, project) pairs per pass;
  - at most 8 concurrent attestations per hub;
  - chosen with an index on `(possibly_active_until, last_attested_at)`.

  It verifies each returned attestation's signature and bindings (project,
  account, attesting bay) before raising a floor.
- **Timing, as documented:** detection within one poll interval, then
  delivery as in §3. The 30 s attestation lease only bounds new admission.

## 6. The revocation table, row by row

| Action | This gate |
|---|---|
| Revoke / disconnect | `revoked_at`, epoch: end to every session; ended at the challenge |
| Re-pair (tombstone) | end (`replaced`) the same way |
| Account deleted | end (`deleted`), written inside `markAccountDeleted`'s transaction |
| Network narrowed, account paused | floors (computer epoch): queued work cancelled, running continues (documented) |
| Project becomes ineligible | project floor via §5: its queued and running jobs stopped |
| Effective policy narrowed | policy push: queued work with the old epoch cancelled, running continues |
| Time limit | local (exists) |
| Per-agent stop | deferred: stage 1 has no per-agent grants beyond network membership |

## 7. Tests

- **e2e, with a real conat server and connector:**
  - revoke during a running job, with one and with two simultaneous sessions:
    every session acks through the grace path, and every job is killed;
  - revoke while offline: the next challenge answers ended, and the jobs are
    killed;
  - the same with the site switch off;
  - the same after a key rotation: the chain verifies;
  - account deletion while connected and while offline;
  - a project gains a collaborator during a run and during a 50-minute
    exec: killed within one poll; other projects' jobs continue;
  - an ack lost after application: redelivery is harmless (idempotent), and
    a stale attempt's ack can't finalize a newer version;
  - the grace path refuses anything but the matching ack subject (ops,
    reports, other correlations, another session).
- **Unit tests:**
  - the daemon:
    - policy apply (newer only, within P0);
    - expired-certificate termination;
    - endorsement-chain verification (an unknown or other-bay endorser is
      refused);
  - the targets:
    - a target row in the same transaction as each change (rolled back
      together);
    - lease, claim and finalize under concurrent hubs;
  - the poller: batch and concurrency bounds, and verification of the
    attestation it gets back.
