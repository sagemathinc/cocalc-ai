# AI Thread Rendering: Bounds and Remaining Work

Audit date: 2026-09-26. Starting revision: `e3853e82f0` (`origin/main`).

## Diagnosis

The oversized-row hypothesis is correct. The list uses **react-virtuoso**, not
react-virtualized, but a virtual row is still an entire chat message. Virtualizing
messages does not bound the cost of parsing, decorating, highlighting, or laying
out one enormous message.

| Path                                                                               | Finding                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Chat list](../src/packages/frontend/chat/chat-log.tsx)                            | `MessageList` virtualizes messages. `createCodexActivityBlocksStore` also retains inline block arrays for the lifetime of the view.                                                             |
| [Message body](../src/packages/frontend/chat/message.tsx)                          | Selectable AI output uses read-only `EditableMarkdown` with `disableWindowing`. It previously received the entire message or concatenated visible activity.                                     |
| [Inline activity](../src/packages/frontend/chat/message-state.ts)                  | The default 100-item limit counted blocks, not characters. One block can contain megabytes. The old "show earlier" action cumulatively raised that limit.                                       |
| [Activity drawer](../src/packages/frontend/chat/codex-activity.tsx)                | Normalized entries were all mounted with `entries.map`. Full Markdown for the Copy button was also constructed eagerly on updates.                                                              |
| [Static Markdown](../src/packages/frontend/editors/slate/static-markdown-core.tsx) | An eager `useState` argument reparsed unchanged Markdown on every component render, including internal state renders.                                                                           |
| [Log hooks](../src/packages/frontend/chat/use-codex-log.ts)                        | Persisted logs are fetched and live events merged as complete arrays. The 100-item display limit is not a data-retention or download limit. Recent-log caches were limited only by entry count. |
| [Agents workspace](../src/packages/frontend/agents/workspace-page.tsx)             | Visited workspaces accumulated in a Set and stayed mounted while hidden unless explicitly closed.                                                                                               |

[Interrupted-response recovery](../src/packages/chat/src/acp.ts), specifically
`getInterruptedResponseMarkdown`, joins recorded agent blocks into a durable
response. This explains how a long interrupted turn can produce an unusually
large message. The code joins with blank lines; this audit does **not** establish
that paragraph boundaries were lost in the reported session.

## First PR: Bound Rendering Without Deleting Content

- Bound message Markdown and activity Markdown fields to 16,384 UTF-16 code
  units before parsing and commit-link formatting. Only one excerpt is mounted.
  Next/previous/first/last controls replace the excerpt, rather than growing it.
  Boundaries preserve surrogate pairs.
- Keep read-only Slate and formatted selection serialization. Full source is
  still available through explicit Copy actions. There is no persisted
  truncation and no automatic replacement of a response with a summary.
- While generating, follow a bounded tail window. Manually paging back stops
  following; "Follow latest" resumes it. Completion keeps the current excerpt
  mounted; it does not navigate back to the beginning. A newly opened completed
  response starts at its beginning. Terminal input/output is fenced after
  slicing so each excerpt remains a code block.
- Keep activity in the same labeled container while running and after
  completion, preserving the reader's Slate selection. Final-response
  deduplication removes only a matching trailing response, not a combined
  commentary block that merely contains it. Ambiguous overlaps remain visible
  rather than risk hiding commentary. The cached and persisted-log paths use
  the same rule.
- Render at most 100 inline activity blocks and 100 normalized drawer entries
  at a time, including after live updates or navigation to earlier activity.
  Inline blocks use a lazy concatenated text source: displaying an excerpt
  does not first allocate the whole concatenation.
- Make static Markdown's initial parse lazy. Materialize the complete activity
  export only on Copy, not on every log update.
- Retain at most three agent workspace views. Evict inactive views after five
  idle minutes (checked every 30 seconds). Only React views are removed; this
  does not stop agents or close shared editor actions. Composer drafts already
  persist and flush when their last mounted view releases them.
- Reject recent-log cache entries above an approximate 1 MiB budget, 2,000
  events, or a bounded traversal budget. Cache entries expire after five
  minutes; LRU expiration is checked on access. This is not a global heap limit.

### Why Paging, Not Cumulative Load More?

Increasing a character limit each time eventually reconstructs the original
failure. A fixed-size window keeps parser input bounded after every navigation.
Unbounded "show all" would defeat that guarantee, so it is intentionally absent.

Fixed excerpts are not a lossless Markdown _layout_. A list, table, math block,
guidance block, or fence spanning a boundary may look incomplete on that page.
The original source and its full-copy export remain unchanged. Syntax-aware
windowing can improve this later, but must not parse the entire source first.

## Validation and Limits

Focused tests use multi-megabyte paragraphs and block-rich Markdown, inspect
the actual parser inputs, exercise page navigation by accessible button name
and keyboard, and check that Unicode pages reconstruct the source exactly.
Real static and read-only Slate renderers retain formatted selection
serialization. Other tests cover live growth, activity jumps, lazy copying,
view eviction, and cache admission.

Completion regressions render the real message and read-only Slate components:
`hello` remains visible and selected when `done` arrives, including when a
preview block contains both. Tests also cover a disappearing live-log feed,
explicit keyboard collapse, retained tail/manual pages, and persisted-log
deduplication. The original implementation fails the commentary-retention and
DOM-identity assertions.

The new static-parser regression fails against the original eager initializer:
a parent rerender parses unchanged text a second time. It passes with lazy
initialization. Existing activity/export, message-state, composer-draft, and
Slate selection/streaming tests are part of the focused verification.

The existing Chromium chat harness could not build: its shims lack current
frontend exports (including agent mentions and chat actions). It first failed
on a missing browser Buffer resolution; resolving that exposed 209 missing
export errors. Harness repair is not included in this change. These results
are component-level evidence, not a production browser performance profile or
a replay of the reported 24-hour session. Full browser smoke testing, narrow
viewport/zoom checks, and long-running heap measurements remain necessary.

### This Is Not Yet "Cheap No Matter What"

1. **Bound ingestion and reduction.** Fetch historical logs in pages, retain a
   byte-bounded live tail, and maintain incremental projections. Today some
   operations still scan, normalize, reconcile, or join the whole history
   before rendering. Dropping raw events without preserving terminal/config
   context would be incorrect.
2. **Bound every retained representation.** The per-chat block store, shared
   editor state, stream objects, and active full logs are outside the recent-log
   cache limit. View eviction reduces React trees but does not prove all related
   data is released.
3. **Bound non-Markdown payloads and aggregate work.** Diffs, subagent lists,
   peer-message cards, attachments, and rich embeds need their own budgets.
   A 100-entry page can still contain many bounded but expensive fields. Source
   length is not a strict bound on DOM nodes, image memory, or math-rendering
   time. A drawer-wide budget or row virtualization is a useful next step.
4. **Clarify turn presentation separately.** Present one turn with explicit
   status, an expandable activity transcript, and a final response only when
   one exists. Interrupted turns should label recovered output as interrupted
   activity, not imply that accumulated commentary is a final answer. Preserve
   message boundaries and channel information in storage rather than guessing
   them back from Markdown. This PR deliberately leaves recovery semantics
   unchanged.

Before claiming a whole-thread bound, measure main-thread long tasks, heap after
visiting many agents, and retained heap after eviction. Include a multi-megabyte
single row, many short messages, huge terminal output, a long interrupted turn,
and continuously arriving events. Separate parser/layout cost from log fetch
and reduction cost in those measurements.
