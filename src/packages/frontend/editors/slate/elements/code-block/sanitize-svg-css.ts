/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
CSS policy for the SVG mermaid renders (see sanitize-mermaid-svg.ts).

Diagram CSS can come from the diagram itself (themeCSS, fontFamily, ...), and a
<style> inside inline SVG applies to the whole page.  So CSS is parsed by the
browser's CSS parser (CSSOM in an inert document), never filtered as text,
and rebuilt from the parsed rules:

- Only style rules (also inside @media/@supports) and @keyframes are kept;
  @import, @font-face and every other at-rule are dropped.
- Every selector is rewritten to only match the diagram's own root SVG and its
  descendants: `:is([scope], [scope] *):is(<selector>)`, where [scope] is a
  random attribute the sanitizer puts on the root.  Nothing outside the
  diagram can be selected, whatever the selector says.
- @keyframes names are global, so each is renamed to a scope-specific name
  and animation-name references are rewritten to match; references to any
  other keyframes become none.
- Custom properties (--*) and any declaration using var(), env() or attr()
  are dropped: substitution happens after this check, so it could bring
  back anything the check removes.
- Any declaration whose value contains a backslash is dropped: the CSSOM
  keeps escapes in function names (v\61r() is var()), so they could spell
  any of the above past these checks.  Mermaid's CSS has none.
- Any declaration whose value uses a function that can load a resource
  (url() other than a same-document #fragment, image-set(), image(),
  cross-fade(), element(), src(), ...) is dropped, as are fixed and sticky
  positioning, which could cover the page.

The same declaration policy applies to style attributes and to presentation
attributes.  Values are judged in their parsed, canonical form, so CSS escapes
and alternate spellings don't matter.
*/

const RESOURCE_FUNCTION =
  /(?:^|[^\w-])(?:-webkit-|-moz-)?(?:url|image-set|image|cross-fade|element|src|paint)\s*\(/i;
const SUBSTITUTION_FUNCTION = /(?:^|[^\w-])(?:var|env|attr)\s*\(/i;
const FRAGMENT_URL = /url\(\s*(["']?)#[\w.:-]*\1\s*\)/gi;
const SCOPE_TOKEN = /^[A-Za-z0-9-]+$/;
export const SCOPE_ATTRIBUTE = "data-cocalc-svg-scope";

// True if a CSS value could load anything other than a same-document
// fragment.
export function isExternalCssValue(value: string): boolean {
  return (
    SUBSTITUTION_FUNCTION.test(value) ||
    RESOURCE_FUNCTION.test(value.replace(FRAGMENT_URL, ""))
  );
}

function isUnsafeDeclaration(property: string, value: string): boolean {
  if (isExternalCssValue(value)) {
    return true;
  }
  return property.toLowerCase() === "position" && /fixed|sticky/i.test(value);
}

// Remove unsafe declarations from a parsed declaration block, and point
// animation names at this diagram's renamed keyframes (others become none).
function sanitizeDeclarations(
  style: CSSStyleDeclaration,
  keyframes: Map<string, string> = new Map(),
): void {
  for (const property of Array.from(style)) {
    const value = style.getPropertyValue(property);
    if (
      property.startsWith("--") ||
      value.includes("\\") ||
      // A longhand of a shorthand that uses var() reads back as "".
      value === "" ||
      SUBSTITUTION_FUNCTION.test(value) ||
      isUnsafeDeclaration(property, value)
    ) {
      style.removeProperty(property);
    }
  }
  if (
    SUBSTITUTION_FUNCTION.test(style.cssText) ||
    style.cssText.includes("\\")
  ) {
    // Fail closed if a substitution survived in some serialization.
    style.cssText = "";
  }
  const names = style.getPropertyValue("animation-name");
  if (names) {
    const mapped = names
      .split(",")
      .map((name) => keyframes.get(name.trim()) ?? "none")
      .join(", ");
    if (mapped !== names) {
      style.setProperty("animation-name", mapped);
    }
  }
}

// Sanitize the value of a style attribute.
export function sanitizeInlineStyle(value: string, doc: Document): string {
  const style = doc.createElement("div").style;
  style.cssText = value;
  sanitizeDeclarations(style);
  return style.cssText;
}

// Split a selector list at top-level commas.
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(selectorText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const PSEUDO_ELEMENT =
  /(::?(?:before|after|first-line|first-letter)|::[\w-]+(?:\([^)]*\))?)$/i;

function scopeSelector(selector: string, scope: string): string {
  // A pseudo-element can't go inside :is(), so keep it outside.
  const match = PSEUDO_ELEMENT.exec(selector);
  const pseudo = match?.[1] ?? "";
  const base = selector.slice(0, selector.length - pseudo.length) || "*";
  const root = `[${SCOPE_ATTRIBUTE}="${scope}"]`;
  return `:is(${root}, ${root} *):is(${base})${pseudo}`;
}

const STYLE_RULE = 1;
const MEDIA_RULE = 4;
const KEYFRAMES_RULE = 7;
const KEYFRAME_RULE = 8;
const SUPPORTS_RULE = 12;

function keyframesName(name: string, scope: string): string {
  return `cocalc-svg-${scope}-${name}`;
}

// The renamed keyframes defined anywhere in the sheet.
function collectKeyframes(
  rules: CSSRuleList,
  scope: string,
  out: Map<string, string>,
): Map<string, string> {
  for (const rule of Array.from(rules)) {
    if (rule.type === KEYFRAMES_RULE) {
      const name = (rule as CSSKeyframesRule).name;
      if (/^[A-Za-z_][\w-]*$/.test(name)) {
        out.set(name, keyframesName(name, scope));
      }
    } else if (rule.type === MEDIA_RULE || rule.type === SUPPORTS_RULE) {
      collectKeyframes((rule as CSSMediaRule).cssRules, scope, out);
    }
  }
  return out;
}

function rebuildRules(
  rules: CSSRuleList,
  scope: string,
  keyframes: Map<string, string>,
): string {
  const out: string[] = [];
  for (const rule of Array.from(rules)) {
    switch (rule.type) {
      case STYLE_RULE: {
        const r = rule as CSSStyleRule;
        sanitizeDeclarations(r.style, keyframes);
        const selectors = splitSelectorList(r.selectorText).map((s) =>
          scopeSelector(s, scope),
        );
        if (selectors.length > 0 && r.style.length > 0) {
          out.push(`${selectors.join(", ")} { ${r.style.cssText} }`);
        }
        break;
      }
      case MEDIA_RULE:
      case SUPPORTS_RULE: {
        const r = rule as CSSMediaRule | CSSSupportsRule;
        const inner = rebuildRules(r.cssRules, scope, keyframes);
        if (inner) {
          const condition =
            rule.type === MEDIA_RULE
              ? (r as CSSMediaRule).media.mediaText
              : (r as CSSSupportsRule).conditionText;
          const keyword = rule.type === MEDIA_RULE ? "@media" : "@supports";
          out.push(`${keyword} ${condition} { ${inner} }`);
        }
        break;
      }
      case KEYFRAMES_RULE: {
        const r = rule as CSSKeyframesRule;
        const renamed = keyframes.get(r.name);
        if (renamed == null) break;
        const frames: string[] = [];
        for (const frame of Array.from(r.cssRules)) {
          if (frame.type !== KEYFRAME_RULE) continue;
          const f = frame as CSSKeyframeRule;
          sanitizeDeclarations(f.style);
          frames.push(`${f.keyText} { ${f.style.cssText} }`);
        }
        out.push(`@keyframes ${renamed} { ${frames.join(" ")} }`);
        break;
      }
      default:
        // @import, @font-face, @namespace, @page, @layer, ...: dropped.
        break;
    }
  }
  return out.join("\n");
}

// Rebuild a stylesheet so it can only style the SVG carrying
// SCOPE_ATTRIBUTE=scope and loads nothing.  Returns "" if the CSS can't be
// parsed here.
export function sanitizeStyleSheet(
  css: string,
  scope: string,
  doc: Document,
): string {
  if (!SCOPE_TOKEN.test(scope)) {
    return "";
  }
  // An inert document: its stylesheets are parsed but never applied, and
  // nothing in them is fetched.
  const inert = doc.implementation.createHTMLDocument("");
  const style = inert.createElement("style");
  style.textContent = css;
  inert.head.appendChild(style);
  const sheet = style.sheet as CSSStyleSheet | null;
  if (sheet == null) {
    return "";
  }
  const keyframes = collectKeyframes(sheet.cssRules, scope, new Map());
  return rebuildRules(sheet.cssRules, scope, keyframes);
}
