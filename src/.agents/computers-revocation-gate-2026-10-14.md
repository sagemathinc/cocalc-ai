# Computers: revocation that stops running work (stage-1 release gate)

Implementation note, Oct 14 2026. Plan: `computers-plan-2026-10-11.md`
("Revocation semantics", "The computer principal and the data path",
"Multi-bay, rehoming, deletion"). This is the first open release gate from
#1036: *the signed floors/control push and the epoch-close outbox (revocation
must also stop running work)*.

## What exists (main at cf65310d75)

- Every withdrawal of authority bumps `account_computers.epoch`. There are
  five places:
  - `revokeComputer`;
  - the tombstone when a computer is paired again (`requests.ts`);
  - `bumpComputersForNetwork` (member removed, network paused or closed);
  - `bumpComputersForAccount` (account pause or revoke-all);
  - `setEffectivePolicy`, which bumps `policy_epoch` instead.
- The router revalidates each computer session every 15 s, so an epoch bump
  closes the socket. The connector logs in again at the new epoch; a revoked
  or tombstoned computer can't.
- The daemon already has:
  - `applyFloors(envelope)`: a raised computer epoch cancels queued work, and
    a raised project floor cancels that project's queued jobs and kills its
    running ones;
  - `endSession(reason)`: kills all jobs and stops the connector loop.
  - The `cocalc-computer-floors` payload and `parseComputerFloors` exist.
- **Missing:** nothing on the hub ever sends floors, and nothing tells a
  revoked computer to stop. Today:
  - a revoked computer's connector retries forever while its jobs keep
    running;
  - a project that gains a collaborator gets no new tickets (attestations
    last 30 s), but its running jobs continue.

## Design

### 1. Hub → computer pushes on the existing op channel

- A new op-message variant on `computer.<id>.<session>.op.v1`:
  `{ v: 1, correlation, reply_subject, hub_now, push: SignedEnvelope }`
  (instead of `message`). The daemon answers on the same reply subject with
  `{ v: 1, correlation, ack: { applied, floors } }`.
- Two signed kinds, both signed by the home bay's directory key (the same
  keys and the same verification as tickets):
  - `computer-floors` (exists): `{ computer_id, home_epoch, computer_epoch,
    projects: { [project_id]: privacy_epoch }, issued_at }`;
  - `computer-control` (new): `{ type: "cocalc-computer-control",
    computer_id, action: "end", reason: "revoked" | "replaced" | "account",
    issued_at }`.
- **The daemon checks:**
  - the signature against its key directory;
  - `computer_id` is its own;
  - `issued_at` is within the usual clock skew of hub time.
- **Then it applies:**
  - floors through `applyFloors`;
  - `end` through `endSession(reason)`, which kills every job; the connector
    then stops and says "This computer was disconnected in CoCalc".
- **Replays are harmless:** floors only ever rise, and `end` is permanent for
  that computer id.
- Only signed pushes act. An unsigned error string never ends a session (the
  site switch, for instance, only pauses it).

### 2. An outbox, written in the bumping transaction

- A new table `account_computer_pushes` at the account's home bay (an
  account-home table like the others):
  - `push_id`, `computer_id`, `kind` ("floors" or "control");
  - `payload` (jsonb, unsigned), `created_at`;
  - `delivered_at`, `attempts`, `last_error`.
- One helper, `enqueueComputerPush(client, computer_ids, …)`, called inside
  each of the five transactions above:
  - revoke and tombstone write `control end`;
  - network and account bumps write floors with the new computer epoch;
  - `setEffectivePolicy` writes floors too (the daemon already refuses queued
    work whose policy epoch is stale; running jobs continue, as documented).
- **Coalescing:** a newer floors push supersedes older undelivered ones for
  the same computer (floors are cumulative), and `end` supersedes everything.
- Payloads are signed at delivery, with the bay's current key.

### 3. Delivery

- A loop at the home bay: on a short timer, and promptly after a computer
  logs in. It takes undelivered pushes for computers with a live session
  (`FOR UPDATE SKIP LOCKED`, so any hub process can deliver).
- It publishes over the same relay client as operations and waits for the
  ack. Then it sets `delivered_at`, or records the error and backs off.
- A computer without a live session keeps its pushes until it logs in again.
  So a lost push is delivered on reconnect: "applied on reconnect" in the
  plan's table.
- Pushes are delivered before the session is closed:
  - the session-closing revalidation stays the backstop;
  - for `end`, the hub tries the live session first, and the router then
    closes the socket at the next check anyway.

### 4. A revoked computer that is offline

- When a revoked or tombstoned computer asks for a login challenge, the
  challenge endpoint answers `{ ended: <signed computer-control end> }`
  instead of a challenge. The request is already signed by the computer's
  key, so only that computer gets it.
- The connector verifies the envelope, the daemon ends the session (killing
  every job), and the connector stops retrying.
- Without a valid signature, the connector treats the answer like any other
  failure and retries.

### 5. A project that stops being private

- The privacy epoch (`runtime_authority_revision`) is bumped by a trigger on
  the project's row, on the project's bay; the home bay isn't told.
- Rather than a new cross-bay notification, the home bay **re-attests the
  projects that have work on connected computers**:
  - every 30 s, for each connected computer, the distinct projects of its
    `run` operations that aren't known to be finished, plus exec operations
    from the last few minutes;
  - it uses the existing `attestProject` call;
  - when a project's privacy epoch is higher than the floor last pushed, it
    enqueues a floors push with `projects: { P: epoch }`.
- This matches the plan's documented window: the attestation is good for at
  most 30 s, and floors are pushed after it. It needs nothing new on the
  project's bay, and a lost notification can't lose it.
- Until computer→hub reports exist (gate 3), "not known to be finished"
  means every run operation of a connected computer. That set is bounded by
  the operations table, and it shrinks once reports land.

## Not in this gate

- "Also stop its jobs" when a single agent loses access: stage 1 has no
  per-agent grants beyond network membership, so running jobs continue, as
  documented.
- Effective-policy pushes beyond the policy epoch, key-directory updates by
  push, and multi-bay homes stay as they are (single home bay; directory
  rotation by login).

## Tests

- e2e, with a real conat server and connector (`connect.e2e`):
  - revoke while a job runs: the job is killed, and the connector stops with
    the message;
  - revoke while the computer is offline: on its next login attempt, the
    challenge answers `ended`, and the jobs are killed;
  - narrowing the network: queued work is cancelled, running work continues;
  - a project gains a collaborator: its running job is killed within one
    re-attestation, and other projects' jobs continue;
  - a push lost while disconnected is delivered on reconnect, exactly once;
  - a forged or unsigned `end` (wrong key, other computer id, stale
    `issued_at`) is ignored.
- Unit tests:
  - outbox coalescing;
  - every bump site writes its push in the same transaction (rolled back
    together);
  - delivery under concurrent hubs (`SKIP LOCKED`).
