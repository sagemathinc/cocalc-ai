/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
KaTeX "trust" policy for math that other people wrote.

KaTeX's trust option gates the commands that can add links or raw HTML
attributes: \href, \url, \includegraphics, \htmlClass, \htmlId, \htmlStyle
and \htmlData.  Deny by default, and allow only links to http(s) and mailto.
*/

const ALLOWED_LINK_COMMANDS = new Set(["\\href", "\\url"]);
const ALLOWED_PROTOCOLS = new Set(["http", "https", "mailto"]);

export function katexTrust(context: {
  command?: string;
  protocol?: string;
}): boolean {
  return (
    ALLOWED_LINK_COMMANDS.has(context.command ?? "") &&
    ALLOWED_PROTOCOLS.has((context.protocol ?? "").toLowerCase())
  );
}
