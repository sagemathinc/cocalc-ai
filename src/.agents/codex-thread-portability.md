# Codex Thread Portability Plan

This note records the design for making CoCalc Codex chats portable across
servers by exporting and importing:

- the chat transcript and thread metadata
- optional blobs/assets
- the latest real Codex context

The core user goal is simple: export a valuable Codex thread from one CoCalc
server, import it on another server, and continue working from the same context.
This should also support importing the same bundle multiple times in order to
spawn multiple fresh agents from a known context state.

## Product Goals

- Export a Codex thread in a way that preserves the actual resumable agent
  context, not just the visible chat transcript.
- Import that exported bundle into another CoCalc chat file and create a fresh
  imported thread that can continue in Codex.
- Keep the feature fully usable from `cocalc-cli`, not just the frontend UI.
- Keep the archive format self-documenting and suitable for automation.

## Non-Goals

- Do not persist huge amounts of old Codex context purely for archival
  completeness.
- Do not rely on upstream app-server to provide a native import/export thread
  primitive, because it does not currently provide one.
- Do not rebind imported assets to ordinary project files. Imported assets
  should remain blobs.

## Key Decisions

### 1. Use raw Codex session files for portability

CoCalc already uses upstream app-server `thread/fork` for live context copying,
which is the correct primitive for local branching. However, upstream app-server
does not provide a `thread/import` equivalent that could recreate a stored
thread on another server from `thread/read` output alone.

Therefore the portable export must include the raw Codex session JSONL file for
the thread's latest session id. This provides an exact seed state for later
resume/fork on another server.

### 2. Do not enable `persistExtendedHistory: true`

We explicitly do **not** want to turn on `persistExtendedHistory: true` for this
feature.

Reasons:

- the `.chat` log is already the human-readable durable history
- the primary need is the latest resumable context state
- extended upstream history would consume disk space for old context we do not
  expect to use

### 3. Imported sessions must always be re-forked

An imported Codex session should never be used as the live working session
directly.

Instead:

1. import the exported session JSONL as a local seed session
2. immediately `thread/fork` that seed session
3. persist the new forked session id into the imported thread's `acp_config`

This is important because:

- importing the same bundle multiple times should work cleanly
- each imported thread should get an independent future
- the seed session remains a stable source for repeated imports/forks

### 4. `Include Codex context` should default to checked

For Codex threads, the export modal should show:

- `Include blobs/assets`
- `Include Codex context`

`Include Codex context` should be **checked by default** for Codex threads.

Reason:

- most users export a Codex thread either for portability or for later resume
- exporting a visible conversation without the actual context will feel broken
  and misleading in the common case

If the user unchecks it, show a small warning alert making the consequence
explicit, e.g.:

> This export will include the conversation, but not the actual Codex session
> context. Importing it elsewhere will create a thread without resumable Codex
> state.

### 5. Import/export must be CLI-first

This feature must be fully usable from `cocalc-cli`.

That is a hard requirement because:

- users should be able to automate export/import
- agents must be able to perform export/import for users
- it should be possible to say “export this thread, move it, then import it”
  without needing browser-only UI steps

This means the core implementation belongs in shared/package code and CLI
commands, not in frontend-only code.

## Proposed UX

### Export

Existing thread menu keeps:

- `Export...`

Export modal adds:

- `Include blobs/assets`
- `Include Codex context`

Behavior:

- for Codex threads, `Include Codex context` defaults to checked
- for non-Codex threads, the control is hidden or disabled
- unchecking it shows a small warning alert

### Import

Add:

- `Import...`

Best location:

- next to `Export...` in the existing chat/thread menu

Reason:

- import/export belong together conceptually
- it is more discoverable than hiding import in account settings
- “new chat” is plausible but less direct

Import creates new thread(s) in the current chat file. The modal should state
that explicitly.

## Bundle Format

Extend the existing chat export bundle.

For each exported thread:

- `threads/<thread-id>/thread.json`
- `threads/<thread-id>/messages.jsonl`
- `threads/<thread-id>/transcript.md`
- optional `threads/<thread-id>/codex/meta.json`
- optional `threads/<thread-id>/codex/session.jsonl`

`codex/meta.json` should include at least:

- original exported session id
- exported thread id
- checksum of `session.jsonl`
- relevant Codex config metadata from `acp_config` such as model and session mode

Top-level manifest should record:

- whether Codex context is included
- how many threads include Codex context

No separate `thread/read` sidecar is required for v1.

## Import Semantics

`cocalc import chat` should:

1. read the bundle
2. create fresh target thread ids
3. import thread metadata and messages into the target `.chat`
4. restore blobs/assets if included
5. if Codex context is present:
   - install the exported session JSONL into local Codex session storage
   - fork it immediately with app-server
   - save the resulting fresh session id in the imported thread config

If Codex context is absent, import still succeeds and simply creates normal
chat threads.

## Blob Handling

Imported assets should become **blobs**, not project files.

This is critical.

Reasons:

- blob refs remain portable in later chat exports
- blob refs work well with existing copy/paste behavior
- ordinary project-file rebinding is less portable and uses project storage in a
  less appropriate way
- CoCalc already abstracts blob storage behind hub functionality, so imported
  assets should use the same mechanism

This likely implies shared blob import helpers and potentially future CLI
subcommands such as:

- `cocalc blob import`
- `cocalc blob get`

Those commands are not strictly required to ship the first version of portable
chat import/export, but the implementation should move in that direction rather
than introducing a file-based asset path.

## CLI Surface

### Export

Extend existing command:

```sh
cocalc export chat <chatPath> --scope ... --include-codex-context
```

Behavior:

- export normal chat bundle
- if requested and the selected thread(s) are Codex-backed, include session data

### Import

Add:

```sh
cocalc import chat <bundlePath> --target <chatPath>
```

Behavior:

- import thread(s) into the target `.chat`
- restore blobs if present
- restore/fork Codex context if present

This command must work against both:

- `.cocalc-export.zip`
- extracted export directories

## Implementation Placement

Core logic should live outside the frontend:

- `src/packages/export`
  - extend chat export bundle collection
  - add chat import bundle reader/merger
- `src/packages/cli`
  - extend `export chat`
  - add `import chat`
- `src/packages/ai/acp`
  - add helper(s) for importing raw Codex session JSONL and forking it into a
    new session

Frontend responsibilities should be small:

- expose export checkbox
- show warning when unchecked
- add import modal and invoke the CLI-backed/project-exec path

## App-Server Interaction

Use upstream primitives where they fit:

- `thread/fork` for creating the fresh imported working session

Do not depend on hypothetical upstream import support that does not exist today.

CoCalc already has working code for:

- locating Codex session files
- forking app-server threads
- rewriting resumed session metadata as needed

That should be reused rather than reimplemented.

## Edge Cases

### Import same bundle multiple times

Supported and desirable.

Each import should:

- create fresh CoCalc thread ids
- create a fresh forked Codex session id

### Bundle without Codex context

Import should still succeed and create ordinary threads/messages.

### Bundle with Codex context but no local Codex runtime available

Import should still restore the conversation and report a clear warning that the
Codex context could not be activated.

### Session id collision on import

Do not reuse the imported session id as the final working session. Import as a
seed, then fork.

## Suggested Implementation Order

1. Extend chat export bundle with optional Codex context files.
2. Add session import helper in `ai/acp`.
3. Add `cocalc import chat`.
4. Add frontend `Import...` flow.
5. Add blob-backed asset import/rebinding.
6. Polish warnings and UX copy.

## Validation Expectations

Minimum validation for the first implementation:

- export/import a Codex thread with no assets
- export/import a Codex thread with blobs included
- import the same bundle twice into the same project and confirm each imported
  thread gets a distinct session id
- confirm imported Codex thread can continue immediately
- confirm pure CLI round-trip works without frontend assistance

## Summary

This feature is not just a small UI improvement. It is a portability layer for
valuable Codex work.

The correct model is:

- export the visible CoCalc chat thread
- optionally export the real underlying Codex session
- import the bundle elsewhere
- immediately fork that imported session into a fresh local working agent

That gives users a practical way to back up, move, clone, and resume agents
without manually digging through `.codex` files.
