# Exploratory Scenario Catalog

This file is a repo-owned catalog of exploratory QA scenarios for CoCalc.

It is meant for bug hunting that does not start from `wstein.tasks`. The goal is
to exercise real user workflows, find regressions proactively, and turn good
scenarios into repeatable probes over time.

## Principles

- Prefer realistic user flows over synthetic unit-sized interactions.
- When possible, define an explicit invariant:
  - action,
  - expected visible result,
  - expected document/backend state,
  - what must not change.
- Treat friction or brittleness in `cocalc` CLI and browser automation as a
  bug-hunt result, not just an obstacle.
- For notebook behavior, use JupyterLab compatibility as the reference for core
  interaction semantics. The UI may look different, but basic notebook behavior
  should match:
  - cell execution,
  - markdown edit/render mode,
  - selection,
  - focus,
  - restart/interrupt,
  - output persistence,
  - readonly behavior.
- Categorize scenarios as:
  - `smoke`: very fast and should almost always pass,
  - `stress`: heavier output, size, or concurrency,
  - `weirdness`: focus, restore, selection, reload, race conditions.

## Scenario Template

Use this shape when turning a catalog item into a runnable probe:

- area
- class: `smoke`, `stress`, or `weirdness`
- setup
- actions
- assertions
- compatibility notes
- likely failure surfaces

## Jupyter

### Smoke

- Create a notebook, run `2+3`, expect output `5`.
- Create a notebook, run `print("hello")`, expect one stdout output and no duplicate execution.
- Create a markdown cell with `# Title`, render it, expect heading output and edit mode to toggle back on double-click or equivalent.
- Run `import pandas as pd; pd.DataFrame({"a":[1,2]})`, expect a rendered table with two rows.
- Add three code cells, run them in order, expect execution counts to increase monotonically.
- Save, reload, and expect code, outputs, and cell ordering to persist.
- Rename the notebook while open, expect the title, tab state, and document content to stay aligned.
- Open a readonly notebook, expect viewing to work and edits to be blocked without corrupting the document.

### Stress

- Paste a large multi-cell notebook fragment, expect cell boundaries and content to survive intact.
- Run a cell that prints many lines, expect output rendering to remain usable and kernel state to return to idle after interrupt.
- Create a notebook with many markdown and code cells, scroll deep, reload, expect active-cell and viewport behavior to remain sane.
- Run a cell that emits a large dataframe or long text output, then collapse/expand or revisit it, expect the output model to remain stable.

### Weirdness

- Run `1/0`, expect a visible traceback and a still-usable kernel afterward.
- Run a long sleep cell, interrupt it, expect kernel status to return to idle promptly.
- Restart the kernel, rerun one cell, expect stale outputs not to masquerade as fresh results.
- Convert a code cell to markdown and back, expect content preservation and sane mode transitions.
- Open the same notebook in two tabs, edit in one, expect the other to update without selection corruption.
- Select cells with keyboard only, move them, delete them, undo if available, and compare the behavior with JupyterLab.
- Copy and paste cells backward and forward across mixed markdown/code regions, expect the same basic semantics as JupyterLab.

## Terminal

### Smoke

- Open a terminal, run `echo hello`, expect `hello`.
- Run `python3`, evaluate `2+3`, expect `5`.
- Run `clear` and `reset`, expect the terminal to remain usable.
- Open two terminals and run different commands, expect outputs not to cross.

### Stress

- Run a command with sustained stdout, expect bounded CPU and continued interrupt responsiveness.
- Paste a multiline shell script, expect each line to arrive once and in order.
- Resize the frame during output flood, expect wrapping and cursor state to remain sane.

### Weirdness

- Interrupt a long-running process with `Ctrl+C`, expect the prompt to recover promptly.
- Close a terminal after heavy output, create a new terminal, expect no stale backend state to leak across sessions.
- Exercise CPR-sensitive flows such as paste, prompts, and line editing, and compare behavior with a normal xterm workflow.

## Chat

### Smoke

- Create a new chat, send one message, expect input clears and one message appears.
- Create a new thread, expect the UI to switch to it immediately.
- Select a message, click `New Chat`, expect selection clears and a fresh thread opens.
- Use inline thread search, jump to a hit, expect the correct message to be centered and highlighted.
- Open global chat search, type a query, expect the search field to accept typing and results to update.

### Stress

- Create many threads, switch between them rapidly, expect selection, drafts, and thread metadata to remain coherent.
- Send while an agent turn is running, expect no draft loss or duplicated clears.
- Reload a chat with many threads and archived history, expect thread selection and scroll behavior to remain sane.

### Weirdness

- Open a codex activity log, navigate from a file/commit link, then return to the thread, expect no stale floating controls or selection leakage.
- Start composing in markdown mode, switch threads, come back, expect no duplicated text or stale callbacks.
- Search for a message, select it, then close search, expect stale search selection not to keep driving the view.

## Files and Editors

### Smoke

- Create a markdown file with an image and reopen it, expect render still works.
- Rename an open file, expect tab title and content to remain aligned.
- Open many file tabs, close several, expect tab ordering to remain stable.

### Stress

- Open a large text file, scroll deep, reload, expect restore behavior to be sane.
- Open the same file in two frames, edit in one, expect the other to update without jumping.

### Weirdness

- Create files with spaces, unicode, and punctuation in the name, then open, rename, and delete them.
- Use activity/notification links to open files, expect correct target path and content.

## Slate, Markdown, Whiteboard

### Smoke

- Paste a markdown document with code fences, expect structure preservation.
- Add and resize an embedded image, save and reload, expect size persistence.
- Add a code block in whiteboard, type and tab-indent, expect no duplication.

### Weirdness

- Drag-select backward across mixed markdown/code content, expect selection not to break.
- Click in the right margin near an unfocused code cell, expect no jump to top.
- Toggle edit/render or focus states around code cells, expect no cursor-loss or phantom selection.

## Project, Layout, Restore

### Smoke

- Open multiple files and notebooks, refresh the page, expect tabs to restore in the right order.
- Restore a project from backup, then open files/notebooks/chat, expect the layout to be coherent.
- Switch rapidly between frames while typing, expect focus to stay with the active editor.

### Weirdness

- Resize panes, split tabs, drag tabs between frames, then close some of them, expect the frame tree to remain coherent.
- Reload while an async action is running, expect graceful recovery instead of corrupted state.

## Cross-Cutting

### Smoke

- Go briefly offline and reconnect, expect no duplicate sends or stale loading state.
- Compare the same basic workflow in lite and hub-backed mode, expect equivalent core behavior.

### Stress

- Combine long output, many messages, and many open tabs, and watch for CPU, memory, and restore regressions.

### Weirdness

- Repeat the same scenario in a fresh spawned browser session and an existing live session, and note any divergence.
- Treat automation/tooling failures as first-class findings:
  - missing attach context,
  - stale browser ids,
  - brittle selectors,
  - browser action mismatches,
  - bad session cleanup.

## Initial Recommended Batch

These are good first scenarios to convert into repeatable probes:

- Jupyter: `2+3`, markdown render/edit toggle, traceback survivability, interrupt long cell.
- Terminal: `echo hello`, python REPL, `Ctrl+C` recovery, sustained stdout flood.
- Chat: create thread, send, inline search jump, selected-message then `New Chat`.
- Files: rename open file, restore multiple tabs after refresh.
- Slate/Markdown: mixed content selection, right-margin click near code cell.

## Notes For Review

- If CoCalc differs from JupyterLab on notebook basics, flag it explicitly.
- If a scenario is hard to automate because the CLI or browser tooling is brittle,
  record that as a bug-hunt result.
- When a scenario repeatedly finds real regressions, promote it from this catalog
  into a checked-in runnable plan or harness probe.
