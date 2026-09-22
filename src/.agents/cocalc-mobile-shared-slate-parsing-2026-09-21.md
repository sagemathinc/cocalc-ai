# Sharing CoCalc's Markdown/Slate document pipeline with mobile

## Finding

Yes: the existing Slate document is a plausible shared semantic representation
for web and native read-only chat rendering. The mobile prototype currently
uses markdown-it directly and does not reuse this conversion pipeline.
Prioritize extracting CoCalc's established parsing semantics before committing
to an unrelated Markdown dialect. Native rendering is still necessary, but it
can consume a shared document rather than independently interpreting Markdown.

This was a source investigation and a small pure-parser execution probe, not a
native implementation or proof that the full pipeline already runs in Hermes.

## Existing path and reusable boundary

1. `frontend/markdown/index.ts` constructs `markdown_it_slate` with CoCalc's math,
   emoji, checkbox, hashtag, mention, and blank-line plugins.
2. `frontend/editors/slate/markdown-to-slate/parse-markdown.ts` handles front
   matter, source lines, references, and whitespace preservation before parsing.
3. `markdown-to-slate/parse.ts` and its handlers convert tokens into Slate
   descendants through `getMarkdownToSlate`. Element conversion preserves
   CoCalc-specific meaning, not just generic Markdown formatting.
4. `markdown-to-slate/normalize.ts` uses Slate's headless editor and CoCalc's
   normalization plugins. This maintains invariants needed by the web editor.
5. `static-markdown-core.tsx` walks the resulting document, dispatching element
   types through `getStaticRender` and text marks through `Leaf`. It does not
   require an editable Slate surface to display the document.

A native walker can dispatch the same node types to Text/View/native math,
code, link, image, and artifact components. The document is data; using its shape
is distinct from attempting to port Slate's DOM editor to React Native.

## Why existing imports are not ready for mobile

`elements/register.ts` combines `toSlate`, `fromSlate`, `StaticElement`, editable
`Element`, and other behavior in one registration interface. Element modules
register these together through import side effects. Loading their conversion
functions also loads web renderers.

Examples:

- `elements/math/index.tsx` contains useful math conversion alongside a span-based
  renderer, file context, and the web math component.
- `elements/code-block/index.tsx` includes Ant Design, browser feature detection,
  HTML syntax highlighting, and rendering code alongside conversion registration.
- `elements/types-ssr.ts` still imports web component modules. Server rendering
  compatibility is not equivalent to native portability.
- `types-public-viewer.ts` narrows the set, but still registers HTML renderers.
- Normalization imports element and utility modules; these transitive imports
  also need an audit/extraction. Moving the parser entrypoint alone is insufficient.
- `static-markdown-core.tsx` manages DOM selection and CSS styling. Its traversal
  pattern is reusable, but its implementation is not a native drop-in.

Do not import the frontend barrel into Metro or substitute a native registry by
mutating the existing global registration maps.

## Concrete reuse experiment

Executed the existing `frontend/markdown/math-plugin.ts` directly in Node with
mobile's markdown-it 14.2.0 and no DOM or Slate renderer. All four cases passed:

- `$x_1^2$` -> `math_inline`
- `\\(x_1^2\\)` -> `math_inline`
- `\\[ ... \\]` -> `math_block`
- `\\begin{equation}...\\end{equation}` -> `math_block`

This establishes that the math tokenizer itself is portable. It does not prove
all plugins, conversion handlers, normalizers, or native math rendering work.
Existing tests such as `__test__/math-bracket-delimiters.test.tsx`, blank-line
and whitespace tests provide useful parity fixtures for extraction.

## Recommended implementation sequence

1. Extract parser configuration/plugins, pure document types, conversion handlers,
   and required normalization helpers into a renderer-independent shared module
   or package. Keep the existing Slate document shape initially. Slate core may
   remain a dependency where needed; keep slate-react, DOM, CSS, and web UI out.
2. Split conversion registration from web/native renderer registration. Preserve
   web behavior and initialization order. Have web and mobile call the same pure
   entrypoint; avoid copied plugins that drift independently.
3. Compare serialized output against the current implementation on a representative
   corpus: math delimiters and environments, references, lists, tables, code,
   mentions, guidance/agent-message fences, and unsupported/raw HTML. Retain
   editor normalization invariants rather than silently skipping normalization.
4. Add a small native static renderer for the supported chat node set. Use explicit
   native fallbacks for unsupported nodes, never silently discard content. Share
   KaTeX macro and preprocessing data where applicable; use a separately qualified
   native math backend. Inline baseline/selection support remains real work.
5. Test inside streaming/long conversations, including selection, stable identity,
   scroll retention, history prepend, font scaling, and performance. The web
   viewer's DOM-selection deferral does not transfer automatically.

## Relationship to the two external libraries

Markdown Display can act as a render-rule host, but adapting our Slate tree to its
AST may add a redundant layer once we already own a native element registry.
Its key behavior and unmaintained status remain relevant.

Enriched accepts Markdown rather than our Slate document and does not expose a
public custom-node renderer registry in 1.0.2. Passing the original string to it
would parse it again using its own dialect. It may still be useful for ordinary
blocks or as a comparison, but do not promise shared parsing parity from that
arrangement. Selective native components, including a math engine, can be useful
without delegating the entire document format to another parser.

This approach reuses an existing CoCalc document model and parser; it does not
remove the need to implement native presentation. It is the strongest option
identified so far for retaining CoCalc-specific semantics across platforms.
