# CoCalc mobile implementation progress

Date: 2026-09-21
Branch: `feature/cocalc-mobile`
PR: [#671](https://github.com/sagemathinc/cocalc-ai/pull/671)
Plan: [native agent-first application](cocalc-mobile-plan-2026-09-21.md)

## Implemented in the first milestone

- Successful sign-in and saved-account selection now open native My Agents.
- Named agents come from the account registry, not project/session enumeration.
  Native search, pins, hidden-agent restoration, and recency use the same
  organization data as web. Refresh occurs on focus/foreground and pull-to-refresh.
- Moved the pure organization model to `@cocalc/chat-client`; web re-exports it
  and keeps its existing persistence hook. Shared RPC helpers load/save native
  account organization and resolve only the selected project's current host.
- Native agent details support name/description changes, past conversations,
  current conversation, and confirmed fresh-conversation transitions using the
  existing server's expected-thread check and identity/history semantics.
- Native chat uses the existing remote project-host chat service, including
  bounded initial history and explicit older-message loading. Reading no longer
  starts project compute. Send retains normal compute startup.
- Added a guidance control for running agents, distinct from queued sending and
  interruption. Browser handoff now selects the actual thread.
- Draft restoration no longer races a default empty-draft write. Edits persist
  immediately through a per-conversation serialized writer, so a delayed write
  cannot resurrect a draft cleared after sending. Failed/uncertain sends retain
  the draft and do not claim confirmed rejection.
- New screens and conversation chrome use concrete semantic appearance palette
  values for native light/dark themes, with named controls and touch targets.
- Added native component tests with mocked platform primitives, plus focused
  domain/storage tests. This is interaction regression coverage, not device QA.

## Validation

The following checks passed for this milestone:

- chat-client build and Jest suites (32 tests);
- mobile typecheck, storage/protocol tests (16), and native component tests (11);
- web organization suites (16 tests) and frontend typecheck;
- frontend lint, dependency-version consistency, and iOS production bundle export;
- formatting and diff checks.

A production JavaScript bundle export is not an installed iOS application.
No live-account acceptance, simulator visual review, or physical-device test has
been completed for this milestone. No push, audio, or store release is claimed.

## Current boundaries and next work

This is an agent-first foundation, not full plan completion. Native agent
creation, attachments, rich output/artifact viewing and selection feedback,
terminals, dictation/TTS, live voice, push notifications, and distribution remain.
A clearly labeled web Agents management action is available while creation and
other management screens are implemented. It is a temporary capability gap.

The directory reads preference snapshots; it is not yet subscribed to live
account projections. Simultaneous organization writes have the existing
whole-preference last-write behavior. Groups/custom order are respected in the
shared model, but native grouping/reordering controls remain to be designed.
Errors and unavailable-agent states are visible; full capability negotiation and
live cross-bay/device acceptance still need qualification.

Next implement shared agent creation with recoverable intermediate state and
native project/configuration selection, then attachments and artifact viewing.
Prototype live delegation early alongside those features using configurable
membership entitlements, retaining the existing less expensive speech modes.
