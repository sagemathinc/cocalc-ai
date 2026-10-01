# Standalone Lite People adapter

See [People architecture](../../../../docs/people-architecture.md).

This adapter serves standalone single-account/single-project Lite. SQLite keeps
owner metadata and personal state separate; the adapter does not simulate remote
bays or turn historical participants into local members. Conversations reuse the
existing chat runtime, stable identities, extraction, room lifecycle, personal
collection and Library stores. Follow/mute/read policy uses the shared domain
helpers. Hosted invitations and hosted manual Scan are unavailable here.

`lite/main.ts` constructs `createLiteCollaborators`, registers its API and room
service, and wraps the existing filesystem service. `service.ts` connects durable
source intent to the local store and existing artifact catalog. It never walks
unknown storage at startup, on membership changes, page views, or elapsed time.
Normal known-source indexing remains automatic when enabled.

On shutdown, close the room service, drain filesystem writes, then await the
collaboration service's close. Journals, source fences, room identities, aliases,
notification effects, and retry state survive restart. Index omission never grants
access, deletes files, or silently creates a replacement room. Private directories
and metadata databases use 0700/0600 permissions.

Storage-specific SQL stays in this adapter; normalization, extraction, attention,
identity and reference semantics come from the shared util/backend/chat modules.
The complete local API and regression fixtures are in `index.ts`, `index.test.ts`,
`service.test.ts`, and the room/alias/recovery suites.
