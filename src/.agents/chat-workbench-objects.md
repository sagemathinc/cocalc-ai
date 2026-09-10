# Chat Workbench Objects

Status: implementation in progress. Extends the text prototype without replacing
Patchflow, the existing artifact tools, or CoCalc's editors.

## Ordered Delivery

- [ ] File references: stable artifact ID, same-project path, read-only workbench
      preview, explicit Open file, refresh without remounting the frame, useful
      missing/unsupported/oversized states. Current saved content is labeled as
      such; publication captures the locator, not a claim to immutable file bytes.
- [ ] Proposed action lists: bounded structured proposals, per-action editing,
      comments, exact-version approval/rejection, and separate execution outcomes.
      Acceptance uses fictional support replies first, then an explicitly authorized
      real workflow. Never automatically send mail or update tickets during QA.
      Maintainer decision: approve drafts and return exact decisions to the
      originating agent, not dedicated email/Zendesk execution integrations.
      Approval is not execution; no external executor is part of this version.
      The agent subsequently uses cocalc-cli and appropriate temporary fresh
      auth to call the existing hub Zendesk service, which records the reason
      and audit trail. Card decisions do not replace service authorization.
- [ ] GitHub PR: cached metadata with retrieval time, external link, refresh,
      and local review with explicit repository and base/head SHAs. No checkout,
      worktree creation, or remote mutation when opening a card. Issues are a later
      small extension, not required for this objective.

## Boundaries

### First File Slice

Implemented shared `file: {path}` publication payloads through existing artifact
create/update APIs. `markdown` remains the bounded optional-description text
(send an empty string for no description). File locator changes participate in
the exact editing base, and historical publication references retain their old
locator. File content is not copied into chat records.

The workbench supports saved Markdown and source/text previews with an explicit
Refresh and Open file. Refresh retains the mounted preview; missing/read errors
retain the previous text with a stale warning. A 1 MiB text size gate applies.
Raster images and PDFs use the existing authenticated project-host preview URL
and read-only renderer. Selection feedback is implemented below; active formats,
live file updates and live acceptance are not yet completed. Viewer-only cards currently display locators, not file
contents. Do not mark the file milestone complete from this initial slice.

Reuse typed CLI/backend artifact publication with explicit thread/turn identity,
observed-base checks, idempotent retries, and immutable publication records.
Do not encode special objects in Markdown or accept arbitrary renderer props.
Use project-host file access with existing permissions; do not proxy file data
through the hub. Cross-project references are deferred until independently
authorized and routed. Public artifact rendering stays disabled.

The collaborative chat document is not proof of human approval: project code
can edit it. Execution authorization must use authenticated human decisions
bound to the exact proposal revision, rechecked by a trusted executor. Ordinary
agent publication cannot set an authoritative approved state. Retries must not
duplicate external effects; ambiguous results require reconciliation, not a
blind resend. Prototype review-only decisions must be labeled as such if an
executor is not available. Do not imply generic arbitrary commands are safely
authorized by a checkbox.

GitHub cached private data inherits the chat's visibility; explicitly disclose
this when publishing. Tokens are never artifact fields. External text is
untrusted. Review must verify repository identity and object availability;
fetch is an explicit action, and inaccessible/stale information is labeled.

## File History And Feedback

Artifact identity differs from a path. Explicit locator updates retain identity;
shell rename tracking is not promised. Git or TimeTravel references may help
recover prior content, but only a verified exact revision is presented as such.
Selection feedback must pin the displayed bytes/revision and original thread;
refresh must not silently move a selection onto different content. No execution
of notebook cells, HTML, SVG, or services from previewing. Start with text,
Markdown, raster images and PDF where existing preview policies are suitable;
unsupported formats retain Open file.

File feedback now pins the displayed text and file locator in the existing
thread-bound feedback schema. Selection survives refresh as an explicit pinned
snapshot; the agent prompt requires rereading the real file before editing.
The existing feedback size limits still apply. Component tests cover selecting
old text, refreshing to new text, and commenting with the old quote and source.
Live browser acceptance remains outstanding.

## PR Implementation Progress

`github_pr` publication data now carries repository/number, cached status and
checks, retrieval time, full base/head SHAs, and optional absolute local
repository/common-directory paths. Title and Markdown description use the
existing fields. Metadata changes participate in observed-base validation;
publication rows retain their original metadata. Unknown extra fields are not
persisted. Only github.com PR URLs are constructed from validated identity.

The workbench preview shows cached status and description, links to GitHub, and
opens the existing review drawer with a pinned merge-base comparison. An already
open review retains its SHAs when artifact metadata changes. No checkout or
worktree creation is triggered. Local review now verifies the associated Git
common directory, a matching GitHub fetch remote and both pinned commit objects.
An explicit fetch retrieves those SHAs without checking out or updating a branch.
Refresh uses the project's existing gh credentials, validates remote data, and
saves against the observed artifact base. Publication snapshots remain unchanged.
The UI discloses that refreshed metadata is visible to chat collaborators.

The installed gh version lacks baseRefOid in pr view, so refresh uses the PR REST
endpoint for exact base/head SHAs and a separate check rollup query. Check results
are accepted only for the same head; unavailable checks remain unknown. Both
commands were exercised against PR 509. Component/helper tests cover identity
mismatch, missing objects, explicit fetch, refresh and pinned open comparisons.
PR review feedback now uses an explicit originating-thread sender rather than
the Git helper that may create another thread for a different directory. It
preserves the existing thread configuration and composer draft; the reviewed
directory is included as context only. Feedback includes the pinned PR revisions
even after metadata refresh. Missing source threads fail rather than spawning a
new conversation. Viewer-only cards display current and published cached PR data
with canonical external links and no refresh/fetch controls. Live browser
acceptance remains incomplete.

## Action List Implementation Progress

Structured action lists now use the existing artifact publication API and
immutable publication snapshots. Proposals have bounded IDs, titles, targets,
drafts and optional agent-reported execution outcomes/receipts. Review decisions
are separate from publication data and never service authorization.

The workbench supports editing targets/drafts, per-item comments and
approve/reject/undecided decisions. Draft edits invalidate approval. A changed
agent proposal blocks staging until the reviewer explicitly adopts its new
content. Unfinished reviews persist in browser storage scoped by account,
project, chat, thread and artifact; restored data is validated and checked
against the current proposals. This is local review state, not collaborative
approval or fresh auth.

Returning decisions stages the exact drafts in the originating chat, without
sending a message or executing an external action. The composer and sent-message
notice expose decision counts and expandable exact review snapshots. The CLI
exec API declaration describes all three new object payloads. Focused schema,
workbench and composer tests cover these paths. Viewer-only action cards now
display current proposals and published drafts without editable controls or
approval actions. Live browser/agent acceptance and the complete acceptance
matrix remain open.

## Live Acceptance Checkpoint (2026-09-10)

Built frontend revision `92d3b04c00` and restored the stopped local seed hub
(port 9100); other bays were left running. Dedicated browser `8QDTTQAT9G`
(spawn `workbench-objects-20260910`) is usable, unlike the older Chromium QA
tabs. Operator CLI profile: `workbench-owner-qa-20260910`.

The installed runtime CLI predates artifact commands and cannot be modified.
It was left unchanged. Its supported `exec --file` command ran the built
`createProjectChatOps` API through authenticated direct project-host routing,
not filesystem chat JSON. Temporary harness: `/tmp/workbench-object-fixtures.js`.

In `/home/user/chat-workbench-agent-qa-20260909.chat`, thread
`9382a253-236b-4a0e-8c54-4f5a83c46ad9`, published `qa-file-20260910`,
`qa-actions-20260910`, and `qa-pr-20260910`. Create/read succeeded for all three;
identical retries reported replayed and retained the same editing base. All
three cards appeared on the intended existing QA message.

The file card opened the repository README and rendered its saved contents in
the workbench. The action list opened two fictional replies. Approved Alex's
reply, edited it, observed Not reviewed, approved the revised draft, and staged
the decisions. The composer showed one approved and one not reviewed; focus
returned to Ask Codex. No message was sent. Removed the staged QA feedback
afterward; local review draft state remains available for persistence testing.

PR Refresh retained cached metadata but failed because `gh` was unavailable on
the project's command PATH. Added a focused prerequisite error instead of raw
spawn diagnostics. Successful project-side refresh, local review/feedback,
reload, viewer file previews, keyboard/theme/narrow layout and the rest of the
acceptance matrix remain unverified. Do not infer completion from this checkpoint.

## Acceptance

Read-only file cards now offer an on-demand current-saved-file preview using
the existing file renderer and the host project context. No file is loaded
until the native disclosure is expanded; collapsing unmounts the preview.
The publication locator is preserved and explicitly not described as historical
file bytes. No feedback callback or writable chat actions are supplied. This
viewer presentation is inline because read-only chat has no live workbench
frame actions. Focused read-only card and file renderer suites pass (16 tests),
as do frontend typecheck and lint. Live viewer validation remains outstanding.

For each object: CLI create/read/update/retry, current vs publication view,
reload, thread/frame routing, keyboard navigation, light/dark and narrow layout,
missing source, permissions, and malformed payload tests. Preserve existing
Markdown artifact behavior and stale-base guarantees. Validate package-local
tests, typechecks and frontend lint, then live UI with disposable fixtures.

File scenario: publish a compliance Markdown file, preview beside chat, open its
editor, modify it, refresh, verify scroll and exact feedback context. Action
scenario: revise one fictional reply, approve only that version, change it and
verify approval invalidation. PR scenario: preview a known PR, review its exact
commits locally, and handle a newer remote head without silently switching the
review under the reader.
