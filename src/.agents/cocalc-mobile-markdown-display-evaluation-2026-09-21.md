# Markdown Display: extensibility and ownership

## Conclusion

`react-native-markdown-display` offers substantially more application-level
rendering extensibility than Enriched Markdown's released public API. Its
architecture fits a CoCalc-owned Markdown dialect and custom native blocks.
However, upstream explicitly marks the library as no longer actively maintained
and recommends Enriched Markdown. Adopting it should be an intentional decision
to own a small fork or patch layer, not an assumption that its maintenance is
outsourced.

This investigation examined the published 7.0.2 tarball, upstream README,
CoCalc's current math implementation, and a local source-level probe. No app
package changes or native compatibility tests were performed.

## Concrete extension points

The pipeline is Markdown string -> supplied markdown-it parser -> cleanup and
text grouping -> AST -> per-node React Native render rules.

- Supply our own parser instance and plugins through `markdownit`. The installed
  dependency defaults to markdown-it 10; our mobile parser is 14.2.0. The probe
  confirms the release's token-to-AST converter handles representative v14
  tokens, not that every plugin/pipeline stage is compatible.
- Override only `fence`/`code_block` to keep our wrap and copy controls and add a
  separately chosen highlighter. The default fence renderer is plain Text; it
  does not provide syntax highlighting despite showing language-tagged examples.
- Override `image`, `link`, and `blocklink` for attachment resolution, project
  links, previews, and CoCalc navigation. Custom rules can return app components.
- Register custom token types such as `math_inline`, `math_block`, or an artifact
  block, then supply matching rules. HTML-output-only markdown-it plugins are
  insufficient: their token types need native render rules.
- AST nodes preserve content, attributes, source token type, code-fence language
  (`sourceInfo`), and plugin metadata (`sourceMeta`). The published TS ASTNode
  declaration omits some of these runtime fields, so types need a small update.
- A preprocessed AST can be supplied directly, bypassing parsing, or the whole
  AstRenderer can be replaced. With a custom renderer, separate rules/style props
  are ignored. Usually node rules plus a prepared AST are the smaller extension.

Enriched 1.0.2 exposes styling, flags, and event callbacks, but no comparable
public arbitrary node-renderer registry was found. Changes beyond those APIs
would generally require native library work or preprocessing. This is an
architecture distinction, not a claim that Enriched cannot be extended at all.

## Costs we would own

- **Streaming identity:** tokensToAST allocates a new counter-based key for every
  node each parse; default rules use those keys. The local probe confirmed that
  even identical input receives different keys. Changing streamed content can
  therefore remount blocks and discard local state/selection. This is inferred
  from React reconciliation and the verified key behavior, not measured on a
  device. A prepared AST with reconciled stable keys is a prerequisite for a
  serious trial. Positional keys alone are insufficient for arbitrary insertions.
- **Parsing cost:** the string path parses the whole message synchronously for
  each component render. Memoized parser/renderer objects do not make parsing
  incremental. Freeze completed messages, avoid unnecessary rerenders, and
  benchmark growing messages; maxTopLevelChildren slices after child rendering
  and is not true virtualization.
- **Native selection/accessibility:** the default rules spread content across
  Text/View nodes, and do not automatically give us continuous whole-message
  selection or all semantic labels. Rules can add selectable text and headings,
  but native selection across block boundaries requires actual device work.
- **Dependencies and compatibility:** 7.0.2 depends on markdown-it ^10,
  react-native-fit-image ^1.5.5, css-to-react-native, and prop-types. Its permissive
  peer ranges are not proof of React 19/RN 0.86 qualification. The image package
  is imported even if we override image rendering. Check Metro, types, and runtime;
  remove/replace unused legacy dependencies in an owned fork if necessary.
- **Table layout:** default tables are ordinary Views, so narrow-screen horizontal
  scrolling and deliberate column widths still need custom rules.
- **Link callback semantics:** returning true asks the library to open the URL;
  a handler that performs CoCalc navigation should return false to prevent a
  second open. Prefer explicitly owned rules for app navigation.

## Correct math baseline

CoCalc uses KaTeX, not MathJax. Verified in
`src/packages/frontend/misc/math-to-html.ts`,
`src/packages/frontend/components/math/katex.tsx`, and
`src/packages/frontend/jquery-plugins/math-katex.ts`.
The first merges built-in and document macros, applies compatibility transforms,
and handles macro redefinition. Built-ins include Sage-style `\\ZZ`, `\\QQ`,
`\\GF`, and `\\Bold`. Some utility filenames still contain “mathjax”; those names
are not evidence that MathJax is the rendering engine.

RaTeX describes itself as a Rust KaTeX-compatible native engine. That makes it a
plausible math backend for either architecture. Markdown Display itself supplies
no math layout engine. A custom rule could use a native RaTeX component, but
inline baseline/line wrapping, native text attachments, and selection remain
harder than rendering a standalone block. Nesting an arbitrary native View inside
Text is not a portable substitute for inline math integration. A full-message
KaTeX WebView would improve web parity but changes the rendering approach.

Share pure delimiter/macro/preprocessing behavior where practical, rather than
importing DOM/jQuery/CSS-dependent frontend modules into mobile. Evaluate against
our KaTeX output and CoCalc-specific corpus, not a generic LaTeX checklist.

## Recommended decision experiment

Before choosing a renderer, try one custom wrapping code block, one project-link
rule, one custom math token and block, and streaming updates with stable keys in
an isolated Markdown Display preview. Then test inline math, selection, and long
chat scrolling. Compare the same corpus against Enriched's native renderer.

If Markdown Display wins on required extensions, own a narrowly scoped fork with
modern parser dependencies, accurate types, stable identity, and focused native
checks. If Enriched handles the CoCalc math corpus and attachment/navigation
requirements well, its integrated native layout and selection may outweigh the
absence of arbitrary React render rules. Code wrapping alone is not decisive.

## Evidence and sources

Local probe (Node, temporary files only) executed the published AST converter,
changing only extensionless imports to .mjs for Node ESM. With our markdown-it
14.2.0 it confirmed code-language preservation, custom math token/metadata/
attribute preservation, and new keys on identical repeated parses. It did not
execute React Native or the complete renderer.

- [Upstream README and maintenance notice](https://github.com/iamacup/react-native-markdown-display)
- [Published 7.0.2 source](https://registry.npmjs.org/react-native-markdown-display/-/react-native-markdown-display-7.0.2.tgz)
- [Render rules](https://github.com/iamacup/react-native-markdown-display/blob/master/src/lib/renderRules.js)
- [AST converter](https://github.com/iamacup/react-native-markdown-display/blob/master/src/lib/util/tokensToAST.js)
- [RaTeX](https://github.com/erweixin/RaTeX)
