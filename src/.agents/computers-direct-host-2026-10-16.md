# Computers, simplest version: the computer is a client of the project host

Decided by William on 2026-10-16. This replaces the ticket, signed-state and
lease design in `computers-plan-2026-10-11.md` and
`computers-revocation-gate-2026-10-14.md`. That design was never turned on,
so there is nothing to migrate.

## The rule

A computer is attached to exactly one project. Anything running in that
project can run commands on the computer, as the user who connected it.

The project must have one collaborator, its owner, and that owner is the
account that owns the computer. If anyone else is added to the project, the
computer stops working there at once. The project host checks this
locally.

This gives the same trust as an ssh key stored in the project, with three
differences:

- no credential is stored in the project;
- the computer opens no port;
- the owner revokes it centrally, without touching the computer.

## Pieces

**Pairing (hub, account home bay).**
1. The owner creates a request in CoCalc: a name and a project. The
   request id `R-...` is not secret. CoCalc shows a setup line to run on
   the computer.
2. On the computer, `cocalc computer connect <site>/c/R-...` claims the
   request. The hub returns a random secret, which only the computer
   gets, and a four-word phrase. A second claim makes the request
   invalid; it never replaces the first claim.
3. The owner compares the phrase in CoCalc with the one on the computer
   and approves (this needs fresh authentication). The computer row
   stores the hash of the secret. From then on the secret is the
   computer's token.

**Connecting (hub, every few minutes).**
- The computer POSTs its token to `/api/v2/computers/connect`.
- The hub checks:
  - the computer is not revoked;
  - the project exists;
  - its only collaborator is the owner;
  - it is placed on a host.
- The hub returns the host's address and a host token: a `phat-computer-v1`
  token with a 10-minute lifetime.
- The computer connects to the host's conat as the `computer` principal.
  Every 5 minutes it opens a new connection with a fresh token, then closes
  the old one. Answers always go out on the newest connection, so a command
  may outlive the connection, and the token, it arrived on.

**Running a command (project host only).**
- A process in project P, such as an agent using `cocalc computer exec`,
  makes one conat request to `computer.<P>.<computer_id>.exec`.
- The computer runs it in the user's login shell, in its own process
  group, with a timeout and a 1 MB output cap, and replies.
- Delivery is at most once. If the reply is lost, the caller gets an
  error and decides itself whether to retry.
- A command runs only while the computer stays connected. An unplanned drop
  (refused by the host, or the network went away) stops every running
  command.

`cocalc computer list` asks `computer.<P>.hello`, and every connected
computer of P answers.

**Host authorization (`project-host/conat-auth.ts`):**

| Who | Allowed |
|---|---|
| computer principal | subscribe to its own two subjects; publish to `_INBOX.*` (replies) |
| project P (its secret, or an agent token bound to P) | publish to `computer.<P>.*` |
| anyone else | nothing under `computer.` |

The conat server checks a computer socket again every 15 s; revalidation
is keyed on `user.computer_id`. That check refuses the socket if any of
these holds:
- the computer was revoked (the host's memory, filled by the hub's
  `dropComputer` call);
- the project gained a collaborator;
- the token has expired.

**Revoking.**
- The hub marks the computer revoked.
- It calls `dropComputer` on the project's host.
- The host closes the socket within 15 s, and the connector kills
  everything it started.
- If that call is lost, the token's 10-minute lifetime is the bound.

## Stage 1 limits

- The project must belong to the account's home bay and run on a host of
  that bay. Otherwise connecting fails with a clear message.
- `exec` only. Longer work can use `nohup ... &` through exec, as over ssh.
- Agents can't create pairing requests; the owner does, in CoCalc.
