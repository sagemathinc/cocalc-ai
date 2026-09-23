# Mobile Markdown rendering

The mobile reader consumes `@cocalc/util/markdown/parse`, the same DOM-free
CoCalc parser used by the web editor. It renders native components rather than
HTML or a Slate editor. Unchanged messages are memoized.

## Supported reading features

- Headings, emphasis, strikethrough, inline code, nested/numbered lists, tasks,
  quotes, rules, links, emoji, styled hashtags and human/agent mentions.
- Tables with column alignment and horizontal scrolling.
- Fenced code with copy, optional wrapping, and Prism syntax highlighting for
  common programming/scientific languages. Unknown languages and blocks over
  30,000 characters retain plain code, avoiding expensive highlighting.
- Native RaTeX inline/display formulas, CoCalc's math delimiters, equation
  environments, and local TeX definitions. Web KaTeX and mobile RaTeX share
  `@cocalc/util/markdown/math-macros`. Wide display formulas scroll; text size
  and theme follow the device. Invalid/incomplete formulas retain TeX text.
- Raster images from HTTP(S), and relative/absolute project file paths resolved
  against the chat file. Project bytes go directly to the owning host using
  its authenticated lease; project images are limited to 4 MiB. The local
  preview includes a bundled sine plot and requires no server.
- Native presentation of common inline HTML (emphasis, underline, code, links,
  images, and small text), plus multiline Markdown inside collapsible details.
  HTML is parsed as data, with no browser, CSS execution, or embedded scripts.

## Remaining differences from the web reader

This is not complete browser-renderer parity. Arbitrary HTML/CSS, embedded
widgets, Mermaid diagrams, SVG images, authenticated site blob URLs, and image
zoom remain separate work. Complex raw HTML tables/layouts currently retain
text rather than browser layout. Sup/sub typography is approximate. Mentions
and hashtags have distinct styling but no navigation/search action yet.

RaTeX is a separate TeX implementation: unsupported formulas preserve source,
not a claim of complete KaTeX compatibility. Formula selection currently
exposes a TeX accessibility label rather than native character selection.
Markdown-to-speech still uses the existing shared speech pipeline.

## Validation

Open the local **Markdown** agent for the full reading corpus. Development-only
`cocalc:///markdown-preview?sample=math` and `?sample=full` provide focused reading
screens. `.maestro/markdown-math.yaml` checks formulas, macro examples,
collapsible details and the plot; `.maestro/markdown.yaml` checks code controls.

RaTeX changes require rebuilding the native app. Older installed development
builds keep the TeX fallback until rebuilt. Source-only changes use Fast Refresh.
