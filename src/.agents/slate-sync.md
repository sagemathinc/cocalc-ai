# Slate Realtime Sync Plan

---

Fix chat input.

We re-enabled sync for chat input and immediately I got "cursor jumping". I think this is because it writes out foo, i type x, and foo gets echoed back, deleting my x and resetting my cursor.   We still haven't properly addressed this.  Can you think hard about what is going on and try to fix this so we only try to merge genuine upstream changes, or actions like undo/redo or clearing the editor (due to sending messages)?  

---

Goal: restore realtime sync integration for Slate while preserving a stable cursor
and responsiveness. The authoritative state remains **markdown** in syncstring,
but we apply **block-aware, minimal patches** to Slate to avoid cursor jumps.

- Syncstring change listener in editable-markdown:
  - file: [src/packages/frontend/editors/slate/editable-markdown.tsx](./src/packages/frontend/editors/slate/editable-markdown.tsx)
  - uses `SimpleInputMerge` to merge remote+local markdown and then calls `setEditorToValue`.
- Syncstring change listener in block editor:
  - file: [src/packages/frontend/editors/slate/block-markdown-editor-core.tsx](./src/packages/frontend/editors/slate/block-markdown-editor-core.tsx)
  - uses `SimpleInputMerge` to merge remote+local markdown and then updates per-block markdown.

**Merge + apply**

- `mergeHelperRef.current.handleRemote(...)` -> `applyMerged: setEditorToValue`
- `setEditorToValue`:
  - `markdown_to_slate` -> normalize
  - `slateDiff(previous, next)` -> operations
  - `applyOperations` to Slate
  - selection revalidation via `ensureRange` and `resetSelection` fallback
  - **Direct set** optimization for large docs when not focused
- Block editor path:
  - `syncstring` change -> `mergeHelperRef.handleRemote(...)`
  - updates block markdown; per-block Slate editors re-render from markdown.

**Cursor mapping**

- Markdown <-> Slate cursor mapping lives in:
  - [src/packages/frontend/editors/slate/sync.ts](./src/packages/frontend/editors/slate/sync.ts)
- Sentinel remap for remote edits (doc + block):
  - [src/packages/frontend/editors/slate/sync/block-diff.ts](./src/packages/frontend/editors/slate/sync/block-diff.ts)

**Deferral**

- `ignoreRemoteWhileFocused` / `mergeIdleMs` defers merges to avoid cursor jumps,
  but also breaks realtime undo/redo, causes stale state, and chat glitches.
- Current: remote merges apply while focused (block patch always on; ignoreWhileFocused disabled).

## Status update (as of now)

✅ Implemented

- Block signature diffing + patch application.
- Block-patch path in non-block editor.
- Sentinel remap on remote edits (doc + block).
- Block editor remap gated to **remote** merges only (local typing no remap).
- Debug logging (`window.__slateDebugLog = true`) for block + non-block paths.
- Playwright collab harness (`?collab` + `?collabBlock`) and sync tests.
- Jest tests for block diff + sentinel remap.

⚠️ Known issues

- Some Playwright sync tests are still flaky or failing.
- Block editor remap uses timing heuristics (remote/local age).

## 1) Design principles for the fix

1. **Markdown is canonical** (syncstring), Slate is a cached view.
2. **Never replace the whole Slate tree while focused.**
3. **Apply block-level patches** to reduce cursor/selection churn.
4. **Local edits win in ambiguity** (defer remote changes for actively edited blocks).
5. **Selection remapping is block-scoped** (if cursor in unchanged block, keep it).

## 2) Block model

Define a lightweight **block signature** for top-level blocks:

- Type (paragraph, list, code_block, math, html/meta, etc.)
- For lists: include list depth + list type + item text hash
- For code: hash of block content + info string
- For math/html/meta: hash of raw value
- For paragraph: hash of normalized text

Use this signature to compute block diff from markdown -> Slate.

## 3) Diff strategy (two layers)

### A) Markdown merge (existing)

Keep `SimpleInputMerge` to merge remote + local markdown. This returns a new markdown string.

### B) Block diff (new)

Given:

  - old Slate block list (from editor.children)
  - new Slate block list (from markdown_to_slate)
Compute diff:
  - Build a compact string representation of block signatures.
  - Use diff-match-patch (existing fork) or simple LCS on signatures.
  - Map changes to top-level block operations (insert/remove/replace).

Then apply:

  - Only mutate changed blocks.
  - For a changed block, run `slateDiff` **within the block**, not whole document.
  - Keep unchanged blocks untouched (preserves selection).

## 4) Selection / cursor rules

When applying block-level changes:

- If selection is in an unchanged block -> keep selection as-is.
- If selection is in a changed block:
  - Try a local in-block `slatePointToMarkdown` -> `markdownPositionToSlatePoint` roundtrip
  - If mapping fails, move to nearest safe block (prefer next block start).
- If block removed:
  - Move to following block start, else previous block end.

## 5) Handling ambiguity & rapid edits

Use a **local-edit staleness window**:

- If last local edit is within `idleMs`, do not merge *inside* the active block.
- Queue remote changes and retry after idle.
- Still allow merges of blocks far from the cursor.

## 6) Step-by-step implementation plan (updated)

1. **Index blocks** ✅
   - Implemented signature extraction + hashing.

2. **Block diff + mapping** ✅
   - Uses diff-match-patch on signature string.

3. **Apply block patches** ✅
   - Insert/remove at top-level + block-level diff for replaces.

4. **Selection preservation** ✅
   - Sentinel remap for changed lines; keep selection in unchanged blocks.

5. **Integrate with existing merge** ✅
   - Block patch always on; ignore-while-focused disabled.

6. **Tests** ✅ (with caveats)
   - Jest tests for block diff + sentinel remap.
   - Playwright tests for sync in non-block + block mode.
   - Some Playwright tests remain flaky.

7. **Debug / telemetry** ✅
   - `window.__slateDebugLog = true` enables logs + buffer.

## 7) Risk management

If block diff cannot confidently match blocks:

  - Fall back to full doc patch **only when unfocused**
  - or defer until idle to avoid cursor jumps

## 8) Next actions

1. Stabilize Playwright sync tests (reduce timing flake).
2. Decide which debug logs to keep (dev-only or behind flag).
3. Consider whether to keep a runtime kill switch vs always-on.