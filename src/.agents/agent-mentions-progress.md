# Named Agent Mentions Implementation Progress

Date: 2026-09-14.

Implementation worktree: `/home/user/scratch/agent-mentions`, branch
`feature/agent-mentions`, based on RPC foundation PR #558 at `4a1c89014e`.
Contract: `agent-mentions-prototype-plan.md`. The older durable delivery plan is
not being resumed. This document records evidence, not a completion claim.

## Architecture

Retain the existing owner-routed single-attempt messaging RPC and project-host
execution adapter. Store personal names, directional permissions, and account
controls at the human's home bay. Project-owner bays retain agent identities and
execution routing. Neither listing nor approval starts work. Addressing metadata
never grants execution authority.

## Implemented, Awaiting Live Verification

- Account-home directory, retired-name reservations, principal-scoped grants,
  finite/never expiry, paired directional approval, pause/revoke controls, and
  typed connection requests.
- My Agents, naming, typed rich-text/Markdown agent mentions, and point-of-use
  approval with preserved private drafts.
- Immutable human turn authority, cross-human steering rejection, automation
  settings responsibility, and per-turn credential/reference isolation.
- CLI exact named send, destination discovery, and connection request/inspection.
  A selected reference is pinned to an endpoint; no fuzzy destination fallback.
  Typed requests optionally wait using read-only inspection (120 seconds by
  default); waiting never repeats the mutation or sends a message.

## Evidence

- Fresh-worktree dependency installation completed.
- Initial full development build progressed through backend dependencies but
  found nullable expiry integration errors in the existing communication UI.
- CLI build and test compilation passed; 23 focused CLI tests passed, including
  named sends, canonical/coalesced requests, read-only waiting, credential-bound
  references, and lost message acknowledgments.
- 80 server/PGLite tests passed across personal-store, RPC routing, identity
  routing, and retired-delivery suites.
- 63 Conat tests and 45 project-host regression tests passed. These include the
  existing startup/identity paths, not a new live deployment.
- Runtime integration reports 469 focused tests passing across Lite, AI, Conat,
  server, project-host, and CLI (some overlap the suites above).
- Both subsequent full development builds passed after frontend integration
  fixes. Frontend build/typecheck/lint and 106 focused frontend tests passed;
  four shared mention codec tests also passed.
- Project/tools packaging ran successfully during development; rebuild final
  artifacts after the last source change before rollout.
- New implementation has not yet been deployed or live-verified. Existing
  foundation deployment is not evidence for these changes.

## Validation Commands

Run from this worktree:

```sh
pnpm -C src/packages/cli build
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
pnpm -C src lint:frontend
pnpm -C src build:dev
node --test src/packages/cli/build/test/cli/src/bin/core/agent-destination.test.js src/packages/cli/build/test/cli/src/bin/core/agent-message.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat-agents.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/personal-store.integration.test.ts agents/rpc.integration.test.ts agents/identity-routing.test.ts agents/retired-delivery.test.ts --runInBand
pnpm -C src/packages/conat exec jest agents/personal.test.ts agents/protocol.test.ts agents/rpc-attempts.test.ts inter-bay/agent-rpc.test.ts inter-bay/agent-identities.test.ts hub/api/index.test.ts --runInBand
pnpm -C src/packages/project-host exec jest codex-project.test.ts project-start-admission.test.ts codex/agent-identity-lease.test.ts hub/hosts.test.ts --runInBand
```

Logs: `/tmp/agent-mentions-{cli,server,conat,host}-tests.log` and
`/tmp/agent-mentions-build-final.log`.

## Prepared Rollout (Not Executed)

The ignored wrapper `/home/user/cocalc-ai/src/.local/agent-mentions-hub.sh`
selects this worktree and the existing three dev bay databases. It adds
`COCALC_AGENT_PERSONAL_MESSAGING_ENABLED=1` alongside the existing messaging flags.
Host override files in `/tmp/agent-mentions-{source,qa}-host.local.env` have been
installed on both hosts, preserving existing settings. Running host processes
have not yet been restarted to load them.
The running site still uses the PR558 deployment wrapper.

## Deliberate Limitations

- Account rehome fails closed when personal messaging state exists, including
  tombstones and revoked grants. Cross-bay messaging is supported; moving the
  account's home requires a later versioned state migration implementation.
- In-turn approval appears in the current chat through three-second read-only
  polling, not native ACP attention events. Approval never itself sends.
- Per-turn credentials constrain server APIs, not hostile processes sharing the
  same operating-system user. Shared project content can influence model output.

## Remaining Acceptance Work

Integrate and validate package changes, then build/deploy the opt-in path. Test
named composer approval and real request/reply across hosts/bays, including a
stopped receiver. Test successive turns from two authenticated humans and
cross-human steering rejection. Verify rename stability, pause/revoke, expired
approval renewal, cancellation/draft preservation, and honest unknown outcomes.

No product decision is currently blocking implementation. Unfinished integration
and verification are not external blockers.
