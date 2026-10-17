/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The app's palette for output frames.  An opaque frame can't read the page's CSS
variables, so the parent resolves them at the frame's position and posts them;
the frame sets them as its own variables (--shell-*), validating each value.
*/

import { useEffect } from "react";
import type { RefObject } from "react";

export const FRAME_THEME_MESSAGE = "cocalc-frame-theme";

// Colors are --cocalc-ui-* values; the font is the frame's inherited one.
const COLORS = ["text", "surface", "dangerBg", "border", "inset", "hover"];

export interface ShellTheme {
  text: string;
  surface: string;
  dangerBg: string;
  border: string;
  inset: string;
  hover: string;
  fontFamily: string;
  fontSize: string;
  colorScheme: string;
}

// The app palette as resolved at the frame's position (the CSS variables
// inherit onto the iframe element).
export function resolveShellTheme(el: Element): ShellTheme {
  const style = getComputedStyle(el);
  const v = (name: string) =>
    style.getPropertyValue(`--cocalc-ui-${name}`).trim();
  return {
    text: v("text"),
    surface: v("surface"),
    dangerBg: v("dangerBg"),
    border: v("border"),
    inset: v("inset"),
    hover: v("hover"),
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    colorScheme: style.colorScheme?.includes("dark") ? "dark" : "light",
  };
}

export function sameTheme(a: ShellTheme | null, b: ShellTheme): boolean {
  return (
    a != null &&
    (Object.keys(b) as (keyof ShellTheme)[]).every((k) => a[k] === b[k])
  );
}

// Runs in the frame (plain ES5, no dependencies).
// Runs in the frame (plain ES5, no dependencies): sets each valid value as
// --shell-<name>.
export const APPLY_THEME_FUNCTION = `function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    var style = document.documentElement.style;
    var props = ${JSON.stringify([
      ...COLORS.map((name) => [name, "color"]),
      ["fontFamily", "font-family"],
      ["fontSize", "font-size"],
    ])};
    props.forEach(function (p) {
      var v = theme[p[0]];
      if (typeof v === "string" && v && CSS.supports(p[1], v)) style.setProperty("--shell-" + p[0], v);
    });
    if (theme.colorScheme === "dark" || theme.colorScheme === "light") {
      style.colorScheme = theme.colorScheme;
    }
  }`;

// Calls update whenever the app's theme may have changed (explicit
// light/dark, or the system preference).
export function useThemeChanges(update: () => void): void {
  useEffect(() => {
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-cocalc-theme", "class", "style"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
}

// For a frame whose document includes FRAME_THEME_HEAD: posts the theme on
// each load and whenever it changes.
export function useFrameTheme(frameRef: RefObject<HTMLIFrameElement | null>): {
  post: (iframe: HTMLIFrameElement) => void;
} {
  const post = (iframe: HTMLIFrameElement) => {
    // The frame is an opaque origin, so its origin can't be named here.
    iframe.contentWindow?.postMessage(
      { type: FRAME_THEME_MESSAGE, theme: resolveShellTheme(iframe) },
      "*",
    );
  };
  useThemeChanges(() => {
    if (frameRef.current != null) post(frameRef.current);
  });
  return { post };
}

// Put first in a framed document: the app's font, text color and color scheme,
// and the notebook's table style (styles/jupyter/jupyter.css), as defaults --
// :where() has no specificity, so the content's own styles always win.
const FRAME_BASE_CSS = `:where(html){font-family:var(--shell-fontFamily,sans-serif);font-size:var(--shell-fontSize,14px);color:var(--shell-text,CanvasText);background:transparent}:where(body){margin:0}:where(img){max-width:100%}:where(table){border:none;border-collapse:collapse;border-spacing:0;table-layout:fixed;margin-top:1em}:where(thead){border-bottom:1px solid var(--shell-border,#ddd);vertical-align:bottom}:where(tr,th,td){text-align:right;vertical-align:middle;padding:.5em;line-height:normal;white-space:normal;max-width:none;border:none}:where(th){font-weight:bold}:where(tr:nth-child(odd)){background:var(--shell-inset,transparent)}:where(tr:hover){background:var(--shell-hover,transparent)}`;

export const FRAME_THEME_HEAD = `<style>${FRAME_BASE_CSS}</style><script>(function () {
  ${APPLY_THEME_FUNCTION}
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data && data.type === ${JSON.stringify(FRAME_THEME_MESSAGE)}) applyTheme(data.theme);
  });
})();</script>`;

// Puts FRAME_THEME_HEAD before the content, never inside it (see
// injectResizeBridge in autosized-iframe.tsx): it ends up in the head, before
// the content's own styles and scripts.
export function withFrameTheme(html: string): string {
  return FRAME_THEME_HEAD + html;
}
