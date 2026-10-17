/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Helpers for HTML documents that we write into a same-origin popup (printing)
or download as a standalone file.

A popup opened with window.open("") has the app's origin, so any script in
document content written into it runs with the user's session.  Put
PASSIVE_DOCUMENT_CSP first in <head> to stop all script execution in such a
document: inline <script>, event handler attributes, javascript: URLs and
srcdoc iframes (which inherit the policy).  The opener can still call
w.print() and set w.onload, since a CSP only restricts the document's own
scripts.  Stylesheets, fonts and images still load.
*/

export const PASSIVE_DOCUMENT_CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

// Escape text for use in element content or a quoted attribute value.
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
