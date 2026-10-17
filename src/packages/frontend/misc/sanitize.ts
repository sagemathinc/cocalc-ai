/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Updated note in 2022:  frontend/components/html-ssr.tsx
// has some *actual* sanitization code using the xss library.
// It's serious, but can often "break everything", leading to user complaints.
// The implementation below seems just about trying to not crash the DOM,
// and isn't at all a security thing.

/*
This HTML sanitization is necessary in such a case, where the user enters
arbitrary HTML and then this HTML is added to the DOM. For example, a loose
open tag can cause the entire smc page to "crash", when it is inserted via
a chat message and show in the chat box as a message.
There are various tools available to do this, e.g.
* https://www.npmjs.com/package/sanitize-html (which depends on other utilitis, might be handy?)
* https://www.npmjs.com/package/sanitize or *-caja (from google, more standalone)
* https://www.npmjs.com/package/google-caja-sanitizer (only the google thing)
* another option: using <jQuery object>.html("<html>").html()

in any case, almost all tags should be allowed here, no need to be too strict.

FUTURE: the ones based on google-caja-sanitizer seem to have a smaller footprint,
but I (hsy) wasn't able to configure them in such a way that all tags/attributes are allowed.
It seems like there is some bug in the library, because the definitions to allow e.g. src in img are there.

http://api.jquery.com/jQuery.parseHTML/ (expanded behavior in version 3+)
*/

import { sanitize_html_attributes } from "@cocalc/util/misc";
import {
  enforceHtmlSafetyFloor,
  isAllowedHtmlTag,
  shouldDropHtmlTagContents,
} from "@cocalc/frontend/components/sanitize-html";
declare var jQuery: any;

// This renderer only ever filtered attribute *values* for javascript:/vbscript:
// -- it says nothing about dangerous tags, so an <iframe srcdoc="<script>...">
// used to render and execute in our origin. Apply the same floor html-ssr does.
function applySafetyFloor(sani): void {
  sani.find("object, embed, applet, iframe").each(function (this: any) {
    const node = this;
    const attribs: Record<string, string> = {};
    for (const attr of Array.from(node.attributes ?? [])) {
      attribs[(attr as Attr).name] = (attr as Attr).value;
    }
    const floored = enforceHtmlSafetyFloor(node.tagName ?? "", attribs);
    if (floored == null) {
      jQuery(node).remove();
      return;
    }
    if (floored.sandbox != null && floored.sandbox !== attribs.sandbox) {
      jQuery(node).attr("sandbox", floored.sandbox);
    }
  });
}

export function sanitize_html(
  html: string,
  keepScripts: boolean = true,
  keepUnsafeAttributes: boolean = true,
  post_hook?: Function,
): string {
  const sani = jQuery(
    jQuery.parseHTML("<div>" + html + "</div>", null, keepScripts),
  );
  applySafetyFloor(sani);
  if (!keepUnsafeAttributes) {
    sani.find("*").each(function (this: any) {
      return sanitize_html_attributes(jQuery, this);
    });
  }
  post_hook?.(sani);
  return sani.html();
}

export function sanitize_html_safe(html: string, post_hook?: Function): string {
  return sanitize_html(html, false, false, post_hook);
}

// The strictest legacy path, for HTML that other people author (e.g. course
// descriptions written in Markdown): only the central sanitizer's allowlisted
// tags survive; script/style-like tags are dropped with their contents, other
// tags are unwrapped (their text kept); then unsafe attributes and URLs are
// removed as in sanitize_html_safe.
export function sanitize_html_allowlist(html: string): string {
  return sanitize_html(html, false, false, (sani) => {
    // markdown_to_html emits math as <script type="math/tex">: show it as
    // its TeX source instead of dropping it.
    sani.find('script[type^="math/tex"]').each(function (this: any) {
      const display = `${jQuery(this).attr("type")}`.includes("mode=display");
      const tex = jQuery(this).text();
      jQuery(this).replaceWith(
        document.createTextNode(display ? `$$${tex}$$` : `$${tex}$`),
      );
    });
    // Innermost first, so unwrapping a node never skips its descendants.
    const nodes = sani.find("*").get().reverse();
    for (const node of nodes) {
      const name = `${node.tagName ?? ""}`.toLowerCase();
      if (isAllowedHtmlTag(name)) continue;
      // Markdown task-list items render as disabled checkboxes.
      if (
        name === "input" &&
        `${jQuery(node).attr("type")}`.toLowerCase() === "checkbox"
      ) {
        jQuery(node).attr("disabled", "true");
        continue;
      }
      if (shouldDropHtmlTagContents(name)) {
        jQuery(node).remove();
      } else {
        jQuery(node).replaceWith(jQuery(node).contents());
      }
    }
  });
}
