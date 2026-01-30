# Slate Realtime Sync Plan

Goal: restore realtime sync integration for Slate while preserving a stable cursor
and responsiveness. The authoritative state remains **markdown** in syncstring,
but we apply **block-aware, minimal patches** to Slate to avoid cursor jumps.

## 0) Audit of current pipeline (where we are today)

**Entry points**
- Syncstring change listener in editable-markdown:
  - file: [src/packages/frontend/editors/slate/editable-markdown.tsx](./src/packages/frontend/editors/slate/editable-markdown.tsx)
  - uses `SimpleInputMerge` to merge remote+local markdown and then calls `setEditorToValue`.

**Merge + apply**
- `mergeHelperRef.current.handleRemote(...)` -> `applyMerged: setEditorToValue`
- `setEditorToValue`:
  - `markdown_to_slate` -> normalize
  - `slateDiff(previous, next)` -> operations
  - `applyOperations` to Slate
  - selection revalidation via `ensureRange` and `resetSelection` fallback
  - **Direct set** optimization for large docs when not focused

**Cursor mapping**
- Markdown <-> Slate cursor mapping lives in:
  - [src/packages/frontend/editors/slate/sync.ts](./src/packages/frontend/editors/slate/sync.ts)

**Deferral**
- `ignoreRemoteWhileFocused` / `mergeIdleMs` defers merges to avoid cursor jumps,
  but also breaks realtime undo/redo, causes stale state, and chat glitches.

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

## 6) Step-by-step implementation plan

1. **Index blocks**
   - Implement `getBlockSignatures(editor.children)` and `getBlockSignatures(markdown_to_slate(...))`.
   - Include stable hashes (content + type metadata).

2. **Block diff + mapping**
   - Use diff-match-patch on signature string (or LCS) to get insert/remove/replace.
   - Return list of block-level changes with old/new indices.

3. **Apply block patches**
   - For insert/remove at top-level: use `Transforms.insertNodes` / `Transforms.removeNodes`.
   - For replace: run `slateDiff` between old block and new block children.

4. **Selection preservation**
   - Track current block index + intra-block path before applying.
   - Remap after patch using rules in section 4.

5. **Integrate with existing merge**
   - Modify `setEditorToValue` to call block-patch path when focused.
   - Fallback to full `slateDiff` only when not focused or on large structural changes.

6. **Tests**
   - Jest unit tests for block diff mapping.
   - Jest tests for selection preservation in unchanged blocks.
   - Playwright tests for cursor stability during remote edits in a focused editor.

7. **Debug / telemetry**
   - Use `slateDebug()` events for:
     - block diff result
     - selection remap decision
     - deferred merge reasons

## 7) Risk management

If block diff cannot confidently match blocks:
  - Fall back to full doc patch **only when unfocused**
  - or defer until idle to avoid cursor jumps

## 8) Next action (proposed)

Start with a **pure audit + block indexer** PR:
- Implement signature extraction + diff function
- No functional change yet
- Add tests for diff logic in isolation

Then integrate into `setEditorToValue` behind a feature flag (e.g. `COCALC_SLATE_REMOTE_MERGE.blockPatch = true`)

