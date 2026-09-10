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
retain the previous text with a stale warning. A 1 MiB size gate applies. Active
formats, images/PDF, selection feedback, live file updates and live acceptance
are not yet completed. Viewer-only cards currently display locators, not file
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

## Acceptance

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
