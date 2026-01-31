# Slate

## Todo

- [ ] #ux plain text paste: just ALWAYS show the text / code block option, even if only one line; it's just more predictable.

- [ ] #bug keyboard navigation between blocks (left arrow at start, right arrow at end)

- [ ] #bug undo/redo via keyboard (e.g., control+z) doesn't work

- [ ] #feature alt+enter (or command+enter) to jump between rich text and markdown editor, with cursor in the same place; requires mapping position in slate to position in markdown and back. 
  - [ ] this is also needed for jumping from table of contents entries to the document.

- [ ] #bug chat integration: I send a message, input goes blank, then the message I sent re-appears a few seconds later in the input box. This happens every single time even with sync now enabled. 

- [ ] #bug type one character into mode-line popover for code and focus goes back into editor corrupted it with later keystrokes.

- [ ] #feature find (and replace) search in doc; it's not visible at all right now.

- [ ] #feature the entire slate editor bar is just not displayed so can't use any feature.  maybe find is part of that?

- [ ] #unclear block editor -- shift+click in one block when focus is in another should just select both blocks and all between.  If possible, this is "slightly buggy", but basically awesome and very discoverable.  Obviously it possibly slightly overselects.  I'm ok with that.

- [ ] #doc add modal that documents:
  - [ ] keyboard shortcuts
  - [ ] what the editor supports, i.e., a list of features and intentional shortcomings (e.g., block mode selection)

- [ ] #wishlist make the task editor just use a single big slate editor, but with the same filtering and sorting options.  Is this possible in block editor mode now, or a new mode.  It would be SO amazing!

- [ ] #wishlist can we make a jupyter notebook mode?  i.e., a slate renderer for any jupyter notebook, i.e., a new "single document mode"...?

- [ ] #wishlist latex editor.  this would just start as one big prism (+latex mode) code editor, but proportionally spaced! Then we make math formulas display nicely using katex. Then we make \\section{...} etc. display nicely.  Etc.  Just iteratively replace things until it is beautiful and useful... but still usable.

- [x] #bug bring back the realtime sync integration.
  - addresses HUGE problem: we depend on realtime sync for undo/redo and saving current state!  the "do nothing when focused" mode just horribly breaks this.
  - addresses all the chat integration weirdness and a lot of other problems.
  - it's a challenge but now I feel more optimisitic that it's solvable.
  - [ ] in particular - the _user aware_ undo/redo integration (via control+z, etc.) fundamentally relies on realtime collaboration integration.
  - using debouncing I think this can be done in a way that feels very responsive, and never "jumps the cursor".  Which just have to be very careful.

- [x] #feature #easy make the "paste text/code" buttons that appear much clearer -- they blend in since everything is the same grey.   Also, instead of "Dismiss", the other option should be "Code Block". 
  - [ ] #feature add a new feature where you can select the language for those available (hence modeline), so it syntax highlights properly.

- [x] #speed implement static markdown renderer with windowing/virtualization
  - obviously this only makes sense when the html element to display the markdown is fixed height.  But that's everywhere in the cocalc frontend app, except for printing.

- [x] #feature support more prism languages -- it supports over 250 languages, but we only explicitly import a handful.  E.g., latex is very important to use but we didn't import it. See build/cocalc-lite/src/packages/frontend/file-associations.ts to see what we support...

- [x] #bug a bunch of stuff that was working fine with code block navigation/cursors is now broken -- similar to the breaks with html that was badly fixed by a hack of just tossing in a paragraph below it (that should be reverted):
  - it is impossible to enter blank lines in code cells now
  - impossible to get cursor below an empty code cell
  - deleting a code cell using control+d doesn't delete the contents (just unformats it)
  - \`\`\`[space] focus -- focuses the spacer
  - And I can't move my cursor above or below this list I'm writing right now -- I'm trapped.

- [x] #feature eliminate use of codemirror entirely in slate editor as a core editor component; it's way too heavy/awkward

- [x] #bug rewrite math editing -- cursor gets stuck in displayed math: can navigate above it but not below it in block editor mode.  popup doesn't go away. 
  - I think I would much prefer to edit the latex inline (not in a popup) and only maybe use a popup for a preview.  If possible.

- [x] #bug paste a block of code should put cursor in the pasted block or **after** it, not before it.  This works fine for pasting INSIDE a code cell, but not for pasting content that gets turned into a code cell. I think after is the typical UI expectation for pasting content 

- [x] #bug whatever url auto highlighter we use is very annoying because:
  - lots of filenames, etc., `bootstrap.py` get turned into url's - and .py (and .ts) aren't even tld's!
  - it's also NOT necessary to turn these into url format  `[wstein.org](http://wstein.org)`  unless there really is a need -- just leave as [wstein.org](http://wstein.org).

- [x] #bug fix placeholder text when editor is focused - very ugly

- [x] #feature add a "delete forward" keyboard shortcut. 

- [x] switch from codemirror to prism -- fully to fix all the weird cursor issues, etc.
  - [x] Right now backspace at the beginning of a code cell deletes the entire code cell even if it is 1000 lines long. This is annoying -- it easy now to put the cursor after the cell to delete it, which is fine. But backspace at the beginning deleting makes no sense.
  - [x] word wrap - isn't happening 
    - probably easy since it works fine in the official demo
  - [x] copy/paste involving content is totally broken (again), e.g., space removed, etc.
  - [x] in block editor no way to insert text before a code block; in non-block mode there is with gap cursor.
    - status: works now, but loss of focus
  - [x] collapse code block in edit mode:
    - doesn't show the line at bottom about being collapsed (how many lines), which is confusing.
    - control+a to select all in a editor with a currently collapsed block doesn't work. i.e., it somehow breaks selection.
  - [x] large code block doesn't get syntax highlighted -- http://localhost:30004/projects/00000000-1000-4000-8000-000000000000/files/bootstrap.md#line=1 
  - [x] pasting a block of code formats as a block, but loss of all indentation
  - [x] three backticks then space loses focus

- [x] loss of cursor focus after autoformat again.

- [x] #wishlist try to design a way to do multi-block selection in block mode.  Obviously this is limited, but just being able to select cut/copy/paste a range of blocks would be very nice.... if feasible and not broken.

- [x] deprecated - need a clickable/hoverable gap cursor between blocks so can navigate "above a block" without using keyboard
  - [ ] related: code block at bottom of doc: create a blank paragraph automatically in this case (?) or at least add padding?

- [x] pasting should ALWAYS give the plain text/markdown option.  E.g., I'm trying to paste 'Drop codemirror dependencies from frontend package.json/lock if no longer used.' and it ALWAYS turns it into a code block and there is no way to not; and copying out fails because that just makes another code block!

- [x] investigate using their huge document "virtualization"

- [x] jumpiness of the whole editor scroll position when focusing codemirror, esp when the codemirror is big. This is HORRIBLE when you hit it since it makes it utterly unusable.

- [x] playwright testing is broken.

- [x] autoformat with backticks loses focus

- [x] implement block range selection -http://localhost:7000/projects/00000000-1000-4000-8000-000000000000/files/build/cocalc-lite4/lite4.chat#chat=1769506328278 

- [x] evaluate https://www.slatejs.org/examples/huge-document  -- it might not be as scalable as virtualization, but it might be "good enough".  If so, we can switch to it and every problem special to "block mode" goes away and we can focus on only one thing instead of two.

- [x] smart paste

- [x] feature: large code blocks -- if a code block is longer than ~6 lines (?), collapse with a button to show all (make sure virtualization does undo being expanded is probably hardest part).

- [x] ctrl+b for bold, etc.  -- none of these standard shortcuts work anymore

- [x] cursor navigation issues -- often entering codemirror and leaving ends up jumping to totally the wrong place in the document.  Just feels flaky. 

- [x] feature: add keyboard shortcut to move block items up/down. (control+shift+arrow) or ([mac thing]+shift+arrow).  nice for lists but useful in lots of contexts for blocks.

- [x] "control+s" to save-to-disk in block mode (full editor)

- [x] reduce use of "markdown_to_slate" when possible.

- [x] loss of focus: just type this and boom, focus is lost:

---

```
`a b`[space]
```

Similarly, loss of focus on doing this:

```
QUESTION which you didn't answer -- are **ALL
```

then put `**` and space.  No focus!

---

- [x] cursor gets stuck issue:

step 1: this input with cursor on aaa

````md
aaa

```
```
````

step 2: put cursor on aaa, then down into the code block, then back up on aaa.  Now down is stuck and won't go in the code block.

- [x] adjacent codemirror editors -- no gap cursor between them.

- [x] backspace in block mode at the beginning of a block

- [x] If you type "foo", then move to beginning of line and type `-[space bar]` before foo, then foo is just deleted.

- [x] cursor stuck in newly created codemirror editor

- [x] indent/unindent semantics and keyboard shortcuts

- [x] code block at bottom of doc - often cursor totally stuck, especially in chat autogrow mode.

- [x] in block mode, disable newlines are significant for each individual block, since otherwise they work, then disappear, which is confusing.

- [x] task editor COMPLETELY BROKEN. loses all work you do.

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