/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const DOCS_BROWSER_BODY = String.raw`
## Find the guide for your task

Open **Docs** from the public site or inside a project. Search for what you
want to do, such as connecting an agent, choosing compute, or recovering a
file. Open a result for instructions and links to related workflows.

Inside a project, docs can appear as a flyout or a full project tab. When an
entry has an action button, use it to open the relevant project panel. Public
docs use the same articles without project-scoped actions. Your account and
the site's enabled features determine which entries and actions appear.

Use the font size control to adjust the text. This preference is saved in the
browser without changing the zoom level of the rest of CoCalc.

## Keep your own notes

When signed in, you can save private information alongside an article:

- **Star** a page to find it again from the docs index.
- Choose **Add private note** in the toolbar or **Add Note** below the article,
  write a Markdown note, then select **Save note**.
- Check **Done - I learned this page** to mark your progress.

The index can filter starred pages, learned pages, and pages with notes. Its
search also matches the text of your private notes. Notes and progress are
stored with your account; they do not edit the published article or appear
for collaborators. They are separate from [agent memory](/docs/ai/agent-memory).

On the Docs page, **Export** downloads your notes, stars, and progress as a
JSON file. **Import** merges a previous export into your account without
duplicating notes. Keep an exported file private if its notes contain private
information. Neither operation publishes your notes.

## Find documentation from an agent or terminal

With the [CoCalc CLI](/docs/cli/use-cocalc-cli) installed, search for a task,
read a complete guide, or retrieve a short set of relevant excerpts:

~~~sh
cocalc docs search "agent networks" --site-profile cocalc-ai --json
cocalc docs show ai/agent-features --site-profile cocalc-ai --json
cocalc docs skill-context --query "agent networks" --site-profile cocalc-ai
~~~

Search returns matching entry IDs, slugs, summaries, and action IDs. Use
\`show\` with an ID or slug to read the full body. \`skill-context\` returns
compact excerpts for an agent; follow them with \`show\` before executing a
workflow. These commands require no sign-in and do not include your private
docs notes.

The CLI reads documentation bundled with that CLI version. Setting \`--api\`
does not fetch newer articles from a running site. \`--site-profile cocalc-ai\`
includes CoCalc.ai-specific entries; it selects content, not credentials.
For the documentation shipped with a running site, open that site's Docs page.

Agents can also discover [executable docs actions](/docs/documentation/executable-actions)
to open a documented panel in an authorized browser session.
`;

export const DOCS_ACTIONS_BODY = String.raw`
## What executable docs actions are for

Executable docs actions are stable identifiers for UI destinations. Instead of
only saying "open Settings, then Environment, then Secrets", a docs entry can
also name \`settings.environment.secrets\`, and CoCalc can open that panel in
the current browser session.

## Use an action id

1. Open a docs entry that lists an action.
2. Click the action button, or ask Codex to use the action id.
3. CoCalc opens the matching project UI when the action is implemented and
   available.
4. If the action is not implemented yet, use the written steps.

Agents can list actions with \`cocalc browser action docs-list\` and execute one
with \`cocalc browser action docs <action-id>\`. Parameterized actions accept
\`--param key=value\`; project-host actions also accept \`--host-id <id>\`.

## Verify actions

Docs actions should be tested with browser-session verification. The verifier
does not only check that the action returned success; it also asserts that the
expected visible UI appeared.

## Why this matters in CoCalc

Executable docs turn documentation into a bridge between explanation and action.
That is especially valuable for Codex: it can answer a question, open the right
panel, and then continue working in the same project context.
`;

export const BROWSER_AUTOMATION_BODY = String.raw`
## What browser-session automation is for

Browser-session automation lets Codex and other agents safely operate a
restricted set of actions in the exact browser session that asked for help. It
is useful for opening panels, checking visible UI, reading state, and validating
that docs match the product.

## Use the browser session

1. Follow [Test browser workflows with the CLI](/docs/cli/browser-workflows)
   to authenticate for the intended site and resolve the browser and project.
2. Read that session's API declaration and inspect its page before acting.
3. Use high-level actions such as docs actions before falling back to generic
   browser exec scripts.
4. Use assertions such as waiting for text or a URL when verifying behavior.

For local source development only, load the matching development environment.
For a local hub, refresh it with
\`cd src && eval "$(pnpm -s dev:hub:env)"\` before live browser commands.

## Keep automation scoped

Prefer typed actions and restricted QuickJS browser exec APIs over raw DOM
scripts. The goal is enough UI access for useful help and verification, not an
unbounded remote-control surface.

## Why this matters in CoCalc

The same infrastructure that lets Codex open a Secrets modal can also verify
that docs are still true after frontend changes. This makes documentation,
support, and agent behavior part of one testable system.
`;

export const QUICK_NAVIGATION_BODY = String.raw`
## Open Quick Navigation

Quick Navigation is made for the keyboard: switching between projects, files,
frames, and settings never needs the mouse.

- Double-tap **Shift** to open it from anywhere in CoCalc AI, including inside
  an editor or terminal. (Double-Shift is the default; it can be changed or
  disabled, see below.) The search field has focus immediately.
- Type a few letters, use **Up/Down** to select a result, and press **Enter**
  to open it.
- Press **Tab** to move to the frame preview of the selected file, then a
  digit **1–9** to open that frame, or **0** for its chat.
- Press **Escape** to close and return to where you were.

The dialog searches the projects in your project list, the editors open in
projects you have opened in this browser session, starred files, files you
recently used in this browser and tabs remembered for closed projects, recent
files from project history already loaded in this browser, project panels such as
Files or Log, the app pages (Agents, Projects, Artifacts, People, Compute,
Notifications, and Admin for administrators), and account settings. Each file
appears once; its frames are chosen
in the preview on the right. This is not a search of every file on disk. The
shortcut is ignored while another dialog is open.

## Search and switch

Type words or fragments separated by spaces. Each part can match a different
part of the destination: **algebra notes** finds a notes file in the Algebra
project, **dark** finds Appearance settings, and **key short** finds Keyboard
preferences. Matches are highlighted in the name and in its project or path.

Exact names rank first, followed by word prefixes and substrings. Matching
ignores case and accents. If nothing matches, a typo-tolerant pass accepts one
swapped, wrong, missing, or extra character (two in long words) as long as the
first letter is right: **rwn** still finds **rnw.rnw**. Among similarly
matching destinations, open projects come before closed projects, and bookmarked
closed projects come before other closed projects. Within the current project,
files come before the project entry itself: open files first, most recently used
first, then starred and recently opened files. With an empty search this is the
order you see.

**Enter** opens the selected result; an editor opens at its last active frame.
**Escape** closes the dialog and restores your previous focus.

## Select a frame

The preview on the right shows the arrangement of frames inside an editor,
including tabbed frames, numbered 1–9. When the dialog opens it shows the
current editor; while you move through results it shows the editor of the
selected result, and it stays blank for results without frames.

- **Shift, Shift → 2** immediately opens frame 2 of the current editor. No Enter
  is needed.
- Digits are commands only while the search is empty and a preview is shown. To
  search for a number, press **Space** first: **Shift, Shift → Space → 2**
  searches for **2**. Text such as **chapter2** searches directly, and pasted
  text is always a search.
- After selecting a result with **Up/Down**, press **Tab** to move to its frame
  preview, then **1–9** to open that frame, or **Enter** for the frame that was
  last active. Frames beyond 9 can be clicked in the preview.
- **0** goes to the file's chat: it focuses an existing chat frame, or opens the
  side chat first when the layout has none.
- **Tab** cycles only through the dialog's own controls: search, preview,
  Configure, and Help. **Shift-Tab** cycles backwards and returns from the
  preview to the search, keeping your query and selection.

The hint line under the search field names the file and frame the keys act on.
CodeMirror source frames receive their text cursor, including LaTeX source
frames that show an included file.

Preference searches also match the names of the controls on each settings page.
For example, **pre font** or **pref size** finds **Preferences → Editor**, where
font size is configured. Result subtitles show only the settings group.

## Configure or disable the shortcut

Select **Configure** in the title bar to open a separate settings dialog; Escape
or **Done** closes it and returns you to Quick Navigation. Choose double-Shift,
an alternate shortcut, or **Disabled**. For double-Shift, set the maximum
interval between taps (150–1000 milliseconds, 400 by default) and focus the test
button to try it. The alternate shortcuts are **Ctrl+Shift+Space** and
**Ctrl+K** (Command instead of Ctrl on macOS). Ctrl+K takes precedence over
editor keymaps that use it, such as Emacs kill-line and Sublime chords.

These settings are also in **Account settings → Preferences → Keyboard**. That
page has an **Open Quick Navigation** button that works even when the shortcut
is disabled. Both locations edit the same saved preferences.

**Help** in the title bar closes the dialog and opens this guide in the
integrated documentation, in the project's Docs panel when a project is active.
`;
