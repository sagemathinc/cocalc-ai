# LaTeX Hybrid Rich-Text Editing — Design & Architecture

> **Status:** Current implementation reference. The CodeMirror
> source frame for `.tex` files gains a top toolbar plus a set of inline
> widgets that render standard LaTeX constructs (sections, inline styles,
> math, lists, verbatim, links, …) as their typeset equivalents while
> keeping the source canonical and editable. The build pipeline, SyncTeX,
> output panel, and the existing chat/bookmark gutter markers are
> unaffected.
>
> This file is the architecture reference for the feature. The
> historical design-proposal/phasing material (Codex review log, the
> Phase 2.0 `markText` spike and its test matrix) lived here while the
> work was in flight and has been removed now that the engine has
> shipped; see the git history of this file if you need it.

## Goal

Give users of the existing LaTeX frame editor a way to author and edit
`.tex` content with rendered, WYSIWYG-style affordances **without** moving
away from the source-editor paradigm. The CodeMirror frame stays the
canonical view; rendered widgets are a non-destructive overlay the user
can toggle on or off for every LaTeX editor on their current device.

The non-goal is a separate WYSIWYG editor frame. The same buffer, the
same cursor, the same SyncTeX positions — just decorated. The widget DOM
is purely a view layer; saving, building, SyncTeX, line numbers, error
gutters, and every other existing feature operate on the unchanged
buffer.

## UX Summary

### Toolbar

A horizontal bar always rendered above the CodeMirror frame for `.tex`
files:

```
┌────────────────────────────────────────────────────────────────────┐
│ Section▾ Math▾ List▾ │ B I U Size▾ │ 🔗 ⟨/⟩ ⊞ │ [ Rich Text | LaTeX ] │
└────────────────────────────────────────────────────────────────────┘
```

- **Far right:** an antd button-style `Radio.Group`, visually matching the
  Markdown editor mode control, switches between **Rich Text** and
  **LaTeX**. Default is **LaTeX**. The device-wide preference is stored
  directly in localStorage and never synced to collaborators via syncdb.
- **Left of the mode control:** format-action buttons that operate
  on the current selection / cursor regardless of view mode, grouped as
  structure → inline style → insert:
  - **Section▾** — Section / Subsection / Subsubsection / Plain. Wraps
    the selected lines.
  - **Math▾** — insert inline `$…$` or display `$$…$$`. Agent editing
    is opened from a rendered math widget with Shift+click / Shift+Enter.
  - **List▾** — insert itemize or enumerate skeletons. The parser also
    renders description environments already present in the source.
  - **B / I / U** — wrap selection in `\textbf{…}` / `\textit{…}` /
    `\underline{…}`.
  - **Size▾** — wrap the selection in a braced size group, the full
    `{\tiny …}` … `{\Huge …}` ladder (menu derived from the same size
    map the widgets render with, so the two can't drift).
  - **🔗** — insert `\href{url}{text}` via a small dialog.
  - **⟨/⟩** — wrap selection in `\verb` or `verbatim` env (single vs.
    multi-line based on selection).
  - **⊞ Table** — insert a 3×3 `tabular`; the current selection becomes
    the first cell.

  The bar never wraps. When the format controls don't fit (narrow pane
  from a split), they collapse into a single **Format▾** dropdown whose
  submenus mirror the individual controls — driven by a `ResizeObserver`
  comparing the bar's natural content width to its available width (with
  a dead-zone so it doesn't oscillate at the threshold).

### Widget behavior (when Rich Text is selected)

- Each recognized construct is replaced inline by a rendered DOM node via
  CodeMirror's `markText({replacedWith, clearOnEnter})`.
- **Hover** any widget → an antd Tooltip (see `widgets/common.tsx`) shows
  the raw LaTeX source (read-only, monospace).
- **Click / keyboard-enter** a widget → the marker is cleared, the CM
  cursor is placed at the source's left edge, and the editor is focused;
  the source is now editable inline. Clicking requires
  `handleMouseEvents: false` + an explicit `onMouseDown` → `marker.clear()`
  - `cm.setCursor(from)` + `cm.focus()`, because CM cannot position its
    cursor inside a replaced range. Widget DOM carries `role="button"`,
    `aria-label`, and `tabindex` so it is keyboard- and screen-reader
    reachable; `Enter`/`Space` activate it the same as a click.
- On cursor-leave + content change, the marker manager re-applies the
  widget against the new text (the **edit zone**: any widget whose line
  span intersects the cursor selection dissolves to raw source, so typing
  inside a dissolved widget isn't fought by premature re-marking).

### Math widgets and Agent editing

Display math is laid out as a centered block in its own
horizontally-scrollable box. For this initial cocalc-ai port, clicking a
formula behaves like every other widget and reveals the canonical LaTeX
source for manual editing.

Shift+click / Shift+Enter first opens a compact dialog showing the rendered
formula and an instruction field. Its primary **Edit with Agent** button
creates or focuses a Codex Agent conversation in the side flyout, with the
project, full file path, exact formula, line/range, and requested change in
the agent prompt. The formula and requested change are sent as
`visiblePrompt`; operational instructions, raw TeX, and metadata are sent in a
separate `prompt`. `formula-agent.tsx` first tries the project workspace chat
requesting the Agents flyout via `openFloating: true`, then falls back to
dispatching a navigator intent. The
Agent is instructed to edit and verify the live sync document rather than a
stale filesystem copy. Dispatching the request does not itself confirm that
the edit succeeded.

### Per-document math macros

User-defined preamble macros are fed to KaTeX so the in-buffer preview
matches the real compile:

- `latex-macros.ts::extractMacros(text)` scans the **preamble** (text
  before `\begin{document}`; the whole text if there is none) for
  `\newcommand` / `\renewcommand` / `\providecommand`, `\def\name…`, and
  `\DeclareMathOperator`, producing a KaTeX-compatible macro map
  (e.g. `\R → \mathbb{R}`). Definition scanning is restricted to that
  preamble, but the manager still obtains the full buffer with `cm.getValue()`
  and `extractMacros` strips comments before selecting the preamble; this is
  not a constant-cost operation independent of document length.
- The widget manager re-scans on change, diffs the map by
  `JSON.stringify`, and on change disposes **all** live marks so every
  formula re-renders with the new macros. The map is delivered to
  arbitrarily-nested inline math via React Context
  (`MathMacrosContext`) — see `math.tsx` and `widgets/render-inline.tsx`,
  both of which read it with `useContext`.
- The map is passed as the 3rd arg to
  [`mathToHtml`](../packages/frontend/misc/math-to-html.ts); the default
  (no-macros) path still uses the shared module-level macro map so the
  issue-5750 cross-formula `\gdef` persistence keeps working.
- **KaTeX failure is non-fatal:** when a formula can't render (an unknown
  macro, or it's mid-edit and temporarily broken) the widget shows the
  raw LaTeX source (with the KaTeX error on hover), **not** a jarring
  `?math?` marker.

### What renders

| Family         | Constructs                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Sectioning     | `\part` … `\subparagraph` (+ starred)                                                                                              |
| Text style     | `\textit` `\textbf` `\emph` `\underline` `\texttt` `\textsc` `\textsf` `\textrm` `\textsuperscript` `\textsubscript`               |
| Color          | `\textcolor{c}{text}`                                                                                                              |
| Font size      | braced form only: `{\Large …}` (full `\tiny`…`\Huge` ladder → em scale); bare declarations stay raw                                |
| Inline math    | `$…$`, `\(…\)`                                                                                                                     |
| Display math   | `\[…\]`, `$$…$$` (single- or multi-line, within scanner bounds) — centered scrollable block                                        |
| Math envs      | `equation` `align` `gather` `multline` `displaymath` `eqnarray` (supported starred forms; numbering/labels normalized for preview) |
| Verbatim       | `\verb` (inline) and `\begin{verbatim\|Verbatim}…\end{…}`                                                                          |
| Links          | `\href{url}{text}`, `\url{url}`                                                                                                    |
| Lists          | `itemize` `enumerate` `description` — `\begin/\end` markers + `\item` chips                                                        |
| Tier 2 inline  | `\footnote` `\ref` `\cite` `\label` `\caption` `\sout` (ulem) `\hl` (soul)                                                         |
| Prose envs     | `abstract` + theorem family — narrow begin/end chips so inner widgets in the body still render                                     |
| Code listings  | `\begin{lstlisting\|minted}…\end{…}` — covering widget, body is raw code                                                           |
| Document-level | `\title` `\author` `\date` `\maketitle` `\tableofcontents`                                                                         |
| Graphics       | `\includegraphics[opts]{path}` — via `raw_url`; width from `[width=N\textwidth]`; "image not found" fallback                       |
| Glyphs         | `\TeX` `\LaTeX` — typographic logos                                                                                                |
| Structural     | `\newpage` `\clearpage` `\pagebreak` `\linebreak` `\bigskip` `\medskip` `\smallskip`                                               |
| Tabular        | `\begin{tabular}…` — fail-open: emitted only when the colspec parses and every row's cell count matches                            |
| Custom-macro   | unknown `\cmd{…}` not in any allowlist → neutral chip, body in tooltip                                                             |

**Empty-arg handling.** `\section{}`, `\textbf{}`, etc. still render as a
widget with dimmed placeholder text ("empty heading" / "empty math" / …),
click-to-edit.

**Nested rendering.** Text-style and a few other widgets render their
_content_ recursively through `renderInline` (`widgets/render-inline.tsx`),
which reuses the same `parseLines` scanner. So
`\textbf{bold \textit{italic} $x \in \R$}` shows a bold run containing an
italic run and a KaTeX formula — and that nested math gets the document
macro map via `MathMacrosContext`. This is purely presentational (no
`Widget` wrapper); clicks bubble to the outer widget so activating any
part dissolves the whole construct to source.

**Acknowledged gaps.** `\ref`/`\cite` show the literal key (no aux/bib
resolution); `figure`/`table` floats aren't structured (bare
`\includegraphics` is); class/package-specific list-label definitions are
not evaluated. Nested lists use depth-aware default markers (`1.`, `a.`, `i.`,
`A.` for enumerate; distinct bullets for itemize). `\mathbf`/`\mathcal`/…
are rendered by KaTeX inside math widgets, not as separate text-mode widgets.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ LatexCodemirrorEditor (wrapper — index.tsx)                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ <RichEditToolbar />  (toolbar.tsx)                          │  │
│  │   - antd Radio.Group bound to device-wide localStorage mode  │  │
│  │   - format-action buttons via actions.format_action        │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ <CodemirrorEditor … />  (unchanged, standard component)     │  │
│  │  + WidgetManager subscription when Rich Text is on:         │  │
│  │     - wait for actions._cm[id] (CM ready, via polling)      │  │
│  │     - cm.on("change", debounced rescan)                     │  │
│  │     - cm.on("viewportChange", rescan)                       │  │
│  │     - cm.on("cursorActivity", edit-zone reconciliation)          │  │
│  │     on Rich-Text-off / unmount: clear marks, unmount roots  │  │
│  │       React roots (deferred), detach handlers               │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

The editor wire-up lives in
[latex-editor/editor.ts](../packages/frontend/frame-editors/latex-editor/editor.ts),
which sets `cm.component = LatexCodemirrorEditor`. The wrapper forwards
all `EditorComponentProps` unchanged to the underlying `CodemirrorEditor`
— we wrap, we don't fork.

### Marker manager

The pure entry point is
`parseLines(source: LineSource, fromLine, toLine) → WidgetDescriptor[]`;
`parseViewport` adapts a live CodeMirror editor to that interface. A parsed
range can become stale after an edit, so the manager resolves each live
marker's current range before matching it against fresh descriptors. Its
per-instance registry records:

```ts
interface LiveMark {
  marker: CodeMirror.TextMarker; // CM5 handle — use .find() for current range
  type: WidgetType;
  source: string; // captured source, checked against the current buffer
  payloadKey: string; // serialized payload; detects changes such as numbering
  host: HTMLElement; // attached DOM
  root: ReactDOM.Root; // mounted React root
  rerender: (descriptor: WidgetDescriptor) => void;
}
```

**One reconciliation step:** parse the viewport plus its hysteresis margin,
or reuse the cached parse for a cursor-only change. Index fresh descriptors by
`(from.line, from.ch, type, source)`. For each live marker, resolve its current
range with `marker.find()`, exclude the active edit zone, and match using that
current position. Also verify that the live buffer range still equals its
captured source.

A matched marker keeps its marker, host, and React root. It only re-renders
when the serialized payload changes, for example when list items are
renumbered. Unmatched live entries are disposed; unmatched fresh descriptors
outside the edit zone get `createRoot` and `markText`. This is key-based
matching, not LCS. Disposal clears the marker, removes its host, and schedules
the React unmount. Teardown flushes pending unmounts and detaches handlers;
there is no separate post-rescan DOM sweep.

Keeping a matching `TextMarker` alive lets the manager reuse its host and React
root. The manager also disposes markers when their ranges enter the edit zone or
document macros change; disposal explicitly schedules the React unmount.

**Hysteresis** (~±50 lines) prevents tear-down/remount thrash on a
single-line scroll. PDF-scroll → SyncTeX → CM `viewportChange` is
a frequent viewport-change trigger. Markers whose current key and source
still match can survive, but a viewport event invalidates the parse cache and
schedules reconciliation; it is not a no-work path.

### Parser strategy

A focused viewport-scoped scanner — **not** a full LaTeX parser. Three
structural patterns: brace-balanced commands (`\foo{…}{…}`, via a brace
counter); math delimiters (`$…$`, `\(…\)`, `\[…\]`, `$$…$$`);
environments (`\begin{name}…\end{name}`, via a line-by-line env stack).

**Hard rules:** anything from `%` to end-of-line is skipped (covers
`% chat:` / `% bookmark:` markers; escaped `\%` is not a comment); and
parsing is suspended inside `verbatim` / `lstlisting` / `minted` and
`\verb…`, mirroring LaTeX.

### List anchoring — fail-open

`\item` chips render only within balanced
`\begin{itemize|enumerate|description}…\end{…}` whose stack context is
known within the scanner's bounded context (up to 200 lines of lookback and
500 lines of forward environment search). If balance is uncertain (an `\end` just
deleted, or the `\begin` is far above without context), **all** list
marks for that env are cleared and the source shows — better
source-visible than misleading. The `enumerate` counter is computed from
each item's document-order index in its environment. It is stored in the
payload but excluded from the marker matching key, so chips can update their
numbering without remounting when a sibling `\item` is inserted/deleted. Prose between
items stays live, so inner `\textbf` / `$…$` render through the normal
pipeline.

### Agent formula-edit action

The Agent action must capture the marker's current source and range after a
fresh `marker.find()` lookup. The compact dialog requires an explicit user
instruction before it follows the existing `help-me-fix` navigator-intent
pattern to open or reuse the project’s Agent flyout. The Agent receives the
file path and live-document caveat, and is instructed to make and verify the
requested edit.

### React roots & FrameContext

Each widget mounts in its own `createRoot`, which lives **outside** the
editor's `<FrameContext.Provider>`. So every render re-wraps children in
`<FrameContext.Provider value={frameContext}><MathMacrosContext.Provider …>`
(see `widget-manager.tsx`), otherwise frame-context hooks silently return
defaults. Unmounts are deferred via `setTimeout(0)` to avoid racing
React's render cycle; teardown cancels timers and flushes pending root
unmounts.

**useEffect deps must exclude unstable refs.** `useFrameContext()` returns
a new object identity on every parent render (the provider value is built
inline). Including it in the widget-attach `useEffect` deps caused
per-render teardown + re-attach, wiping the reconciler's live-marker
registry. Capture `frameContext` / `editor_actions` via `useRef` and
depend only on `[richEditMode, props.id, props.path]`.

## File layout

Code under `src/packages/frontend/frame-editors/latex-editor/rich-edit/`:

```
rich-edit/
├── index.tsx              LatexCodemirrorEditor wrapper
├── mode.ts                Device-wide localStorage mode + subscriptions
├── toolbar.tsx            Top-bar: format buttons + mode control
├── types.ts               WidgetType, WidgetDescriptor, WidgetProps
├── parser.ts              parseLines / viewport scanner
├── widget-manager.tsx     Live registry + reconcile + CM hooks + macro scan
├── formula-agent.tsx      Formula instruction dialog + Agent prompt dispatch
├── widget-renderer.tsx    Dispatch via Record<WidgetType, Component>
├── latex-macros.ts        extractMacros(text) → KaTeX macro map
├── math-macros-context.ts MathMacrosContext (per-document macros)
├── font-size.ts           {\size …} name → em map (shared by parser + widget)
└── widgets/
    ├── common.tsx         Widget base + EmptyPlaceholder + hover Tooltip
    ├── render-inline.tsx  Recursive presentational renderer (nested constructs)
    ├── text-style.tsx     \textit \textbf \emph \underline \texttt \textsc
    │                       \textsf \textrm \textcolor \text{super,sub}script
    ├── font-size.tsx      {\Large …} braced font-size groups
    ├── section.tsx        \part … \subparagraph (+ starred)
    ├── link.tsx           \href + \url
    ├── verbatim.tsx       \verb (inline) + verbatim/Verbatim env
    ├── math.tsx           Inline + display + envs
    ├── list.tsx           \item chips + list env begin/end markers
    ├── tier2.tsx          \footnote \ref \cite \label \caption \sout \hl
    │                       + abstract/theorem family + lstlisting/minted
    ├── document.tsx       \title \author \date \maketitle \tableofcontents
    ├── includegraphics.tsx \includegraphics[opts]{path} via raw_url
    ├── glyph.tsx          \TeX \LaTeX
    ├── structural.tsx     \newpage \clearpage \pagebreak \linebreak \*skip
    ├── tabular.tsx        \begin{tabular}… (fail-open)
    └── custom-macro.tsx   unknown \cmd{…} fallback chip
```

## Phase 0 findings (still relevant)

Verified directly in the codebase before designing; the load-bearing
ones:

1. **CodeMirror 5** (`codemirror@^5.65.18`). `cm.markText(from, to, {
replacedWith, clearOnEnter, handleMouseEvents, … })` replaces a range
   visually with a DOM node. The current implementation combines that
   CodeMirror API with a live marker registry and React roots in
   `rich-edit/widget-manager.tsx`. The former SageWS source reference is
   absent from the current tree; consult history for that earlier comparison.
2. **Device-wide mode.** `mode.ts` stores `latex` or `rich` under the
   `latex-editor-mode` localStorage key. A same-window event updates every
   mounted LaTeX frame immediately, and the browser `storage` event carries
   changes between tabs. Missing or invalid values default to raw LaTeX.
3. **Accessing the live cm.** `CodemirrorEditor` keeps `cmRef` private and
   stores the instance at `actions._cm[id]`; it _detaches and reuses_ the
   CM DOM across re-renders rather than destroying it, so the wrapper
   must not assume per-render mount/unmount. The manager attaches once
   per CM instance (resolved via `actions._cm[id]`, with a
   `setTimeout(tryAttach, 100)` ready-poll), not per wrapper re-render.

## Risks & mitigations

| Risk                                         | Mitigation                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Parser perf on every keystroke               | Debounce; parse with bounded viewport context; match current position/type/source so unchanged widgets keep their marker/host/root. |
| React mount leaks on rescans                 | Reuse marker/host/root; defer unmount via `setTimeout(0)`; flush pending root unmounts during teardown.                             |
| Cursor edit-point lost on re-mark            | Never move the cursor on re-mark; only re-mark ranges whose text didn't change.                                                     |
| Partial viewport when half an env is visible | Fail-open: render env-spanning constructs only when balance is known; else revert to source.                                        |
| Switch state confuses collaborators          | Device-wide localStorage preference shared by mounted frames and same-origin tabs; never sent through syncdb.                       |
| Chat/bookmark markers conflict               | Chat uses gutter+bookmark; we use `markText({replacedWith})`. `% chat:` / `% bookmark:` lines are comments → skipped.               |
| Formula Agent action races with edits        | Resolve the live marker range when creating the intent; the Agent must use live document APIs and re-check before editing.          |
| Custom macros silently mis-render            | Unknown `\cmd{…}` → neutral chip with hover-source (no false render). Unknown KaTeX macros → raw LaTeX fallback.                    |

## References

- [latex-editor/editor.ts](../packages/frontend/frame-editors/latex-editor/editor.ts) — LaTeX frame wiring
- [rich-edit/index.tsx](../packages/frontend/frame-editors/latex-editor/rich-edit/index.tsx) — wrapper and manager lifecycle
- [rich-edit/widget-manager.tsx](../packages/frontend/frame-editors/latex-editor/rich-edit/widget-manager.tsx) — current marker matching and cleanup
- [rich-edit/formula-agent.tsx](../packages/frontend/frame-editors/latex-editor/rich-edit/formula-agent.tsx) — visible and operational Agent prompts
- [code-editor/codemirror-gutter-marker.tsx](../packages/frontend/frame-editors/code-editor/codemirror-gutter-marker.tsx) — reference for `createRoot` + `FrameContext.Provider`
- [frame-editors/ai/help-me-fix.tsx](../packages/frontend/frame-editors/ai/help-me-fix.tsx) — navigator-intent and Agent-flyout pattern used by formula editing
- [misc/math-to-html.ts](../packages/frontend/misc/math-to-html.ts) — KaTeX rendering wrapper (`mathToHtml`, extra-macros arg)
