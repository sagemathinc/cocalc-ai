/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Efficient backend processing of iframe srcdoc and general text/html messages.

MOTIVATION: Sage 3d graphics.
*/

import { decode } from "he";

// use iframe isolation for really large html (reduce strain on sync)
const MAX_HTML_SIZE = 1_000_000;

export function shouldIsolateHtmlOutput(content: string): boolean {
  if (!content) {
    return false;
  }
  const normalized = content.trimStart().toLowerCase();
  const lower = content.toLowerCase();
  if (
    lower.includes("https://bokeh.org") &&
    lower.includes("bk-notebook-logo")
  ) {
    // Do NOT use an iframe for bokeh no matter what, since this won't work properly.
    // Hopefully the above heuristic is sufficiently robust to detect but not overdetect.
    return false;
  }
  if (lower.includes("plotlyenv")) {
    return true;
  }
  if (content.length >= MAX_HTML_SIZE) {
    // it'll just break anyways if we don't use an iframe -- if we do, there is hope.
    return true;
  }
  if (
    normalized.startsWith("<!doctype html") ||
    normalized.startsWith("<html")
  ) {
    return true;
  }
  return false;
}

export function shouldUseIframe(content: string): boolean {
  return shouldIsolateHtmlOutput(content);
}

export function processIframeContent(content: string): string {
  const decodedContent = decode(content);
  const contentLower = decodedContent.toLowerCase();
  const i = contentLower.indexOf("<html>");
  const j = contentLower.lastIndexOf("</html>");
  // trim content to the part inside the html tags – keep it otherwise
  // this is necessary for wrapping inline html code like for
  // https://github.com/sagemathinc/cocalc/issues/4468
  let src = "";
  if (i != -1 && j != -1) {
    src = decodedContent.slice(i, j + "</html>".length);
  } else {
    src = `<html>${decodedContent}</html>`;
  }
  return src;
}
