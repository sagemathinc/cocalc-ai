# Slate

## TODO

- [x] attempt to copy any text using control+c in a fenced code block and it copies the entire block, not the text

- [ ] codemirror STEALS the cursor, even with no weird warnings in the console.  

- [ ] performance - for a 4000 line document every keystroke takes 1 second and it's completely unusable.

- [ ] find (and replace) search in doc

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

