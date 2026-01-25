# Slate

## Todo

- [ ] indent/unindent semantics and keyboard shortcuts

- [ ] in block mode, disable newlines are significant for each individual block, since otherwise they work, then disappear, which is confusing.

- [ ] "control+s" to save-to-disk in block mode (full editor)

- [ ] chat integration: I send a message, input goes blank, then the message I sent re-appears a few seconds later in the input box.

- [ ] add keyboard shortcut to move list item up/down.


- [ ] copy/paste doesn't work at all anymore

- [ ] add modal that documents keyboard shortcuts

- [ ] find (and replace) search in doc; it's not visible at all right now.


- [x] attempt to copy any text using control+c in a fenced code block and it copies the entire block, not the text

- [x] codemirror STEALS the cursor, even with no weird warnings in the console.

- [x] performance - for a 4000 line document every keystroke takes 1 second and it's completely unusable.

## Our Approach / Limitations

- We are not implementing google docs.  There are many limitations to this slate approach.  Our main goal is users collaborating with AI and themselves over time; not with each other.

- Instead of me making up semantics for what should happen in cases like "indent in a list", let's just say BY DEFINITION that whatever google docs does is correct.

- Testing: use jest unit tests whenever possible; only use playwright for subtle focus/cursor behavior that can't be reasonably tested using jest.

- A Key Constraint: Markdown <-> Slate is not a bijection. Converting markdown to Slate and back is lossy and can change formatting/structure, so we cannot safely merge external markdown updates while a Slate editor is focused and the user is typing. Instead, defer merges until blur (or explicit accept), and show a pending-changes indicator when true remote updates arrive.

## Ideas for Quality Improvements and Optimizations of Core Implementations

- [x] Scope the `selectionchange` listener to focus/blur instead of always\-on. Right now it’s attached globally in [src/packages/frontend/editors/slate/slate\-react/components/selection\-sync.ts](./src/packages/frontend/editors/slate/slate-react/components/selection-sync.ts); only listening while the editor is focused reduces noise and cross\-editor interference.
- [x] Skip `updateDOMSelection` when Slate selection hasn’t changed. You can track a `lastSelection` ref and early\-return in [src/packages/frontend/editors/slate/slate\-react/components/selection\-sync.ts](./src/packages/frontend/editors/slate/slate-react/components/selection-sync.ts); it cuts a lot of needless DOM selection churn.
- [x] Debounce `scrollCaretIntoView` to once per animation frame and skip on programmatic updates. It’s currently in a layout effect in [src/packages/frontend/editors/slate/slate\-react/components/editable.tsx](./src/packages/frontend/editors/slate/slate-react/components/editable.tsx) and can run very frequently under load.
- [x] Reduce per\-render work in `Children`: `Editor.range` and `Range.intersection` are done per child every render, especially heavy without windowing. Consider caching per node key or only computing decorations for visible nodes in [src/packages/frontend/editors/slate/slate\-react/components/children.tsx](./src/packages/frontend/editors/slate/slate-react/components/children.tsx).
- [x] Avoid updating `NODE_TO_INDEX` / `NODE_TO_PARENT` for the full tree on every render. In [src/packages/frontend/editors/slate/slate\-react/components/children.tsx](./src/packages/frontend/editors/slate/slate-react/components/children.tsx) this now updates only for rendered children in windowed mode.
- [x] Add a lightweight invariant guard around `toSlateRange` / `toDOMRange` errors. You already catch/log, but formalizing a “leave selection unchanged if mapping fails” rule in [src/packages/frontend/editors/slate/slate\-react/components/selection\-sync.ts](./src/packages/frontend/editors/slate/slate-react/components/selection-sync.ts) reduces unexpected jumps.
- [x] Use `Editor.withoutNormalizing` around bulk changes in markdown sync to reduce redundant normalization passes. The hot path is in [src/packages/frontend/editors/slate/editable\-markdown.tsx](./src/packages/frontend/editors/slate/editable-markdown.tsx).
- [x] Add a targeted regression test harness for selection mapping with zero\-width spans, placeholders, and voids. Those are the risk zones in [src/packages/frontend/editors/slate/slate\-react/components/string.tsx](./src/packages/frontend/editors/slate/slate-react/components/string.tsx) and [src/packages/frontend/editors/slate/slate\-react/plugin/react\-editor.ts](./src/packages/frontend/editors/slate/slate-react/plugin/react-editor.ts); a Playwright test or a small jsdom harness would be enough to catch drift.
- [x] Make selection/mismatch logging configurable via an env flag. That keeps production logs clean but gives you a switch when you need deep diagnostics, still centered in [src/packages/frontend/editors/slate/slate\-react/components/selection\-sync.ts](./src/packages/frontend/editors/slate/slate-react/components/selection-sync.ts).