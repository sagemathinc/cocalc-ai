# Enriched Markdown evaluation

## Recommendation and evidence

Evaluate `react-native-enriched-markdown` 1.0.2 as the replacement for the
handwritten mobile renderer. It covers enough of CoCalc's needs to justify a
native preview trial. Do not extend our general-purpose renderer further before
that trial. Keep app-specific navigation, message actions, speech, and chat state
outside the renderer.

This is a source/package investigation, not build or runtime qualification.
No mobile dependencies, native builds, or deployed services were changed.
Inspected the npm registry metadata, the actual 1.0.2 tarball, its public TS
interfaces, iOS implementation and podspec, and upstream documentation.
Tarball SHA-256:
`2f28daffb6c59a55a0dfcc062765415e10389e05ff805ada913c7e53ee905263`.

## Fit with this app

- We use Expo 57, React Native 0.86, React 19, and the New Architecture. Upstream's
  compatibility table includes RN 0.86 for the 1.0 release family. That is a
  promising documented match, not evidence that our exact monorepo builds.
- Rendering uses native platform text/views and the md4c parser, without a
  WebView. Use `flavor="github"` for tables, task lists, native code containers,
  and block math; the default CommonMark mode is not sufficient for our chat.
- The released API supports selection, copy-as-Markdown menu configuration,
  custom selection actions, link callbacks, font scaling, accessibility labels,
  table styling, and code-copy notifications.
- Native code containers provide a language header and copy control. Tree-sitter
  supplies highlighting. A configured language subset can reduce build scope.
- Existing concrete `usePalette()` colors can populate `markdownStyle`.
  Keep our enclosing message Copy/Read aloud actions and agent status UI.
- Set `enableTaskListItemToggle={false}`: agent checklists should reflect stored
  message content, not toggle locally without a persisted edit.

## Differences and integration work

1. **Wrapping:** the released iOS code container explicitly draws non-wrapping
   text in a horizontal scroll view. No public wrap option was found. Adopting
   it would lose our new per-block wrap control unless added upstream or via a
   targeted extension. Do not recreate the whole renderer just to preserve this.
2. **Math:** native math uses RaTeX, not CoCalc's web MathJax pipeline. Test
   fractions, matrices, aligned equations, long displays, inline baselines,
   macros, unsupported commands, malformed input, dollar currency, and CoCalc
   delimiter conventions. Do not promise full LaTeX/MathJax compatibility.
3. **Released versus main:** current math docs describe `onLatexError`; neither
   the 1.0.2 TS API nor its source contains that callback. Avoid relying on it.
4. **Streaming:** the core accepts updated Markdown and exposes table/code
   streaming modes. In 1.0.2 these modes only apply when `streamingAnimation`
   is true. Upstream also offers `react-native-streamdown` for incomplete-Markdown
   repair and off-JS-thread work, requiring Worklets Bundle Mode configuration.
   Start with the core renderer; benchmark before adding that configuration.
   Test unclosed code fences, changing table rows, completed messages, history
   prepend, selection during updates, and chat scroll retention. Explicitly
   evaluate streaming behavior with animation disabled.
5. **Links and media:** preserve our app's link-routing decisions through
   `onLinkPress`; resolve project-relative references deliberately. There is a
   component-wide `imageRequestHeaders` API, but that is not a substitute for
   resolving each attachment's origin and authorization. App-specific attachment
   handling remains integration work. Disable unused native video support.
6. **Native installation:** this needs a development-client rebuild, not just
   Metro refresh or an OTA JS update. pnpm may skip the postinstall that downloads
   Tree-sitter/RaTeX assets. Account for this explicitly in reproducible setup.
   Enable math explicitly in app package.json so missing RaTeX fails the pod
   installation instead of silently building without math. The published podspec
   uses a vendored static XCFramework; it does not require changing the app to
   dynamic framework linkage. Download configuration and native build config
   resolve at different roots in a monorepo, so verify both.

## Proposed local trial

1. Pin 1.0.2, configure math/highlighting explicitly and video off, and restore
   native assets. Choose Python, JS/TS, shell, JSON, and other supported languages
   based on actual grammar names in the package.
2. Add an Enriched version alongside the existing isolated Markdown preview.
   Keep normal conversations unchanged during the comparison.
3. Build the simulator development client and check light/dark/large-text,
   wide tables, nested lists, images, code copy, text selection, links, math,
   and incremental updates. Inspect VoiceOver behavior separately from screenshots.
4. Run the same corpus inside a realistic long chat to measure layout, scrolling,
   and streaming. Isolated rendering tests alone are insufficient.
5. Build/install on the iPhone and qualify selection, scrolling, and math there.
   Android remains a separate qualification; iPhone results do not establish it.
6. If the trial succeeds, replace the custom renderer with a small styled adapter
   and remove its parsing/rendering machinery. Keep only justified product-specific
   extensions. Treat code wrapping as an explicit tradeoff/upstream feature request.

## Sources

- [Package and compatibility](https://github.com/software-mansion/enriched-markdown/tree/main/packages/react-native-enriched-markdown)
- [Text rendering](https://github.com/software-mansion/enriched-markdown/blob/main/docs/TEXT.md)
- [Math](https://github.com/software-mansion/enriched-markdown/blob/main/docs/LATEX_MATH.md)
- [Streaming](https://github.com/software-mansion/enriched-markdown/blob/main/docs/MARKDOWN_STREAMING.md)
- [Native assets](https://github.com/software-mansion/enriched-markdown/blob/main/docs/NATIVE_ASSETS.md)
- [Inspected release tarball](https://registry.npmjs.org/react-native-enriched-markdown/-/react-native-enriched-markdown-1.0.2.tgz)

Main-branch documentation may describe functionality newer than the inspected
release; the package-source findings above take precedence for the proposed pin.
