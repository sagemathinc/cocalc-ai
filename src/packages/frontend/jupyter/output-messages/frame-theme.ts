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

export interface ShellTheme {
  text: string;
  surface: string;
  dangerBg: string;
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
    colorScheme: style.colorScheme?.includes("dark") ? "dark" : "light",
  };
}

export function sameTheme(a: ShellTheme | null, b: ShellTheme): boolean {
  return (
    a != null &&
    a.text === b.text &&
    a.surface === b.surface &&
    a.dangerBg === b.dangerBg &&
    a.colorScheme === b.colorScheme
  );
}

// Runs in the frame (plain ES5, no dependencies).
export const APPLY_THEME_FUNCTION = `function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    var style = document.documentElement.style;
    [["text", "--shell-text"], ["surface", "--shell-surface"], ["dangerBg", "--shell-danger-bg"]].forEach(function (p) {
      var v = theme[p[0]];
      if (typeof v === "string" && CSS.supports("color", v)) style.setProperty(p[1], v);
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

// Put first in a framed document: the app's text color, font and color scheme
// as defaults (the content's own styles win), following the app's theme.
export const FRAME_THEME_HEAD = `<style>html{font-family:sans-serif;color:var(--shell-text,CanvasText);background:transparent}body{margin:0}</style><script>(function () {
  ${APPLY_THEME_FUNCTION}
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data && data.type === ${JSON.stringify(FRAME_THEME_MESSAGE)}) applyTheme(data.theme);
  });
})();</script>`;

// Inserts FRAME_THEME_HEAD at the start of the document's head, so it comes
// before any of the content's own styles and scripts.
export function withFrameTheme(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head != null) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + FRAME_THEME_HEAD + html.slice(at);
  }
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root != null) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + FRAME_THEME_HEAD + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype != null) {
    const at = doctype[0].length;
    return html.slice(0, at) + FRAME_THEME_HEAD + html.slice(at);
  }
  return FRAME_THEME_HEAD + html;
}
