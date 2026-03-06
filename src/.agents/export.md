# CoCalc Export Spec

## 1. Goal

Add a generic export system for CoCalc documents that is:

- human-readable
- agent-readable
- stable enough for long-term archival
- reusable across document types
- callable from both the frontend UI and the CLI

The first concrete exporter should be chat, but the design should also support:

- whiteboards
- jupyter notebooks
- tasks
- markdown files

This is not just a convenience feature. It is a core interoperability layer for
AI agents. If an agent can export a structured CoCalc document into a stable
bundle, it can often solve user requests that CoCalc does not natively support.

Examples:

- export a whiteboard, then convert it to PowerPoint
- export a chat, then summarize or re-import it elsewhere
- export a notebook with all assets for external review or compliance

## 2. Non-Goals

- The export format is not the same as the live syncdoc format.
- The export format does not need to preserve every internal runtime detail.
- Codex activity/thinking logs are out of scope for archive export.
- Export is not initially an incremental sync protocol.

## 3. Core Requirements

### 3.1 General

Every exporter must support:

- versioned manifest
- deterministic file layout
- optional asset/blob inclusion
- human-readable component
- machine-readable component

### 3.2 Chat-Specific

Chat export must:

- include all messages for the selected threads
- include archived/offloaded messages for those threads
- optionally include all blobs referenced by those threads
- exclude Codex activity/thinking logs
- support exporting:
  - current thread
  - all non-archived threads
  - all threads

Clarification:

- "all non-archived threads" means non-archived in the chat UI
- regardless of thread scope, all selected threads must include their offloaded
  archived messages

## 4. Packaging

The final artifact should be a zip file.

Reason:

- easy for users to download and move around
- preserves multiple structured files
- works well for optional assets
- friendly for CLI automation and testing

Suggested file extension:

- `.cocalc-export.zip`

## 5. Top-Level Architecture

Do not put the export core only in `src/packages/frontend/export`.

If the CLI must use the same exporter, the core belongs in a shared package.

Recommended split:

- `src/packages/export`
  - bundle model
  - manifest schema
  - zip writer
  - asset collection helpers
  - exporter interfaces
  - document-specific export implementations
- `src/packages/frontend/export`
  - export dialogs
  - frame/menu integration
  - progress reporting
  - download/save UX
- `src/packages/cli`
  - command wrappers over `@cocalc/export`

Execution model:

- exporters should run against local files in the environment where the export
  command executes
- for chat, this means reading the `.chat` file and archived SQLite rows
  directly from disk
- export should not require streaming the document contents through websocket or
  RPC first
- network access should be limited to optional asset/blob fetching when an
  exporter explicitly includes assets

## 6. Generic Export Bundle Model

Each exporter should produce an in-memory bundle with:

- manifest
- files
- optional assets

Suggested shape:

```ts
export interface ExportBundle {
  manifest: ExportManifest;
  files: ExportFile[];
  assets?: ExportAsset[];
}

export interface ExportFile {
  path: string;
  content: string | Uint8Array;
  contentType?: string;
}

export interface ExportAsset {
  originalRef: string;
  path: string;
  sha256: string;
  content: Uint8Array;
  contentType?: string;
}
```

Suggested exporter interface:

```ts
export interface Exporter<Options> {
  kind: string;
  collect(options: Options, ctx: ExportContext): Promise<ExportBundle>;
}
```

## 7. Archive Format Principles

The export format must be explicitly versioned and independent of the live
document format.

The live format will continue to evolve. The export format should evolve much
more slowly.

This means:

- manifest must include `format` and `version`
- exported machine-readable data should be normalized and explicit
- exported Markdown is for humans, not the primary reconstruction source

## 8. Chat Export v1

### 8.1 Bundle Layout

Suggested zip layout:

```text
chat-export.zip
├── manifest.json
├── threads/
│   ├── index.json
│   ├── <thread_id>/
│   │   ├── transcript.md
│   │   ├── thread.json
│   │   └── messages.jsonl
└── assets/
    └── <sha256>.<ext>
```

### 8.2 `manifest.json`

Top-level metadata describing:

- export format/version
- export time
- source project/path
- exporter kind
- scope
- options
- whether archived messages were included
- whether blobs were included

Suggested structure:

```json
{
  "format": "cocalc-export",
  "version": 1,
  "kind": "chat",
  "exported_at": "2026-03-06T12:00:00.000Z",
  "source": {
    "project_id": "0000...",
    "path": "path/to/file.chat",
    "includes_offloaded_messages": true
  },
  "scope": {
    "mode": "current-thread",
    "thread_ids": ["..."]
  },
  "options": {
    "include_blobs": true
  }
}
```

### 8.3 `threads/index.json`

Quick index of exported threads:

- `thread_id`
- title
- archived/pinned status
- message count
- date range
- transcript path

### 8.4 `threads/<thread_id>/thread.json`

Thread metadata:

- `thread_id`
- title
- icon/color/image
- pin
- agent kind/model/mode
- `acp_config` if relevant
- loop config/state if relevant
- `root_message_id`
- date range

### 8.5 `threads/<thread_id>/messages.jsonl`

Normalized message rows that are close enough to the current chat model to make
later reconstruction straightforward.

This should include:

- `message_id`
- `thread_id`
- `parent_message_id`
- `sender_id`
- `date`
- `history`
- `generating`
- `acp_thread_id`
- `acp_usage`
- `inline_code_links`

This should not include:

- `reply_to`
- `reply_to_message_id`
- Codex activity/thinking logs

### 8.6 `threads/<thread_id>/transcript.md`

Human-readable transcript.

Requirements:

- readable in plain text or Markdown viewer
- clear thread title and metadata header
- stable message ordering by `parent_message_id` with timestamp tie-break
- distinguish user/assistant/system messages clearly
- link local exported assets when present

Markdown is for humans. Reconstruction should rely primarily on `thread.json`
and `messages.jsonl`.

## 9. Asset / Blob Handling

Chat export must support:

- `include_blobs = false`
- `include_blobs = true`

When `include_blobs = true`:

- collect all referenced blobs for selected threads
- deduplicate by content hash
- write them under `assets/`
- rewrite exported references to local archive-relative paths
- preserve original blob refs in metadata where useful

Blobs should be optional because:

- they may be large
- some users only want transcript data
- some exports are for legal/compliance recordkeeping and should be complete

## 10. Data Sources for Chat Export

Chat export must merge:

- live `.chat` syncdoc rows
- archived/offloaded rows from the archive database

The exporter must not silently omit offloaded messages.

This is the main reason chat export cannot just serialize the current `.chat`
file directly.

## 11. Reconstruction Goal

An exported chat bundle should contain enough machine-readable data that an
agent can reconstruct a reasonable approximation of the current chat format, if
the target system knows the current format.

This does not require a full import implementation on day one.

It does require:

- explicit ids
- explicit thread membership
- explicit parent linkage
- explicit thread config
- explicit ordering inputs

## 12. UI Integration

### 12.1 Chat UI

Replace the current single-thread `Export to Markdown` entry with `Export...`.

The dialog should include:

- scope:
  - current thread
  - all non-archived threads
  - all threads
- include blobs:
  - yes/no

The resulting artifact is the zip bundle.

### 12.2 Frame/Menu Integration

Add frame-level export entry points so users can export a document without
relying on document-specific secondary UI.

This is especially important if export becomes generic across document types.

## 13. CLI Integration

The export system should be first-class in the CLI.

Suggested shape:

```bash
cocalc export chat \
  --project <project-id> \
  --path path/to/file.chat \
  --scope current-thread \
  --thread-id <thread-id> \
  --include-blobs \
  --output chat-export.zip
```

The same CLI design should later support:

- `cocalc export whiteboard`
- `cocalc export jupyter`
- `cocalc export markdown`

## 14. Generic Exporter Direction

Chat should be the first exporter, but not the last.

Other document exporters can reuse the same bundle model:

- whiteboard exporter:
  - markdown summary
  - JSON scene/model
  - blobs/assets
- jupyter exporter:
  - notebook file
  - markdown summary
  - outputs/assets
- markdown exporter:
  - source markdown
  - assets
  - metadata about CoCalc-specific extensions

This is useful not only for users but for AI agents:

- agents can export a document into a stable form they understand
- then convert or process it with ordinary tools
- this expands what an agent can solve even when CoCalc lacks a direct export

## 15. Implementation Order

1. Finish deleting old live chat format support (`reply_to`, root-date identity).
2. Add `@cocalc/export` with:
   - manifest schema
   - bundle model
   - zip writer
3. Implement chat exporter in the shared package.
4. Add CLI support.
5. Replace chat UI `Export to Markdown` with `Export...`.
6. Add generic frame/menu export hooks.
7. Add more document exporters.

## 16. Open Questions

1. Should `messages.jsonl` store normalized current-format rows exactly, or a
   separate archive-specific row schema?
   - Recommendation: archive-specific but very close to current format.  YES

2. Should `thread.json` include loop state?
   - Recommendation: yes, if present, because it is part of thread semantics. YES

3. Should assets be rewritten in Markdown to local paths?
   - Recommendation: yes, when blobs are included.  YES

4. Should import be implemented immediately?
   - Recommendation: no. Preserve reconstructability first, then add import.   AGREED.   i just want "import" to be "on the roadmap".  
