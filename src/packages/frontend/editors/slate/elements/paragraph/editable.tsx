/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register } from "../register";

register({
  slateType: "paragraph",

  Element: ({ attributes, children, element }) => {
    if (element.type != "paragraph") throw Error("bug");

    // Below the textIndent: 0 is needed due to task lists -- see slate/elements/list/list-item.tsx

    if (hasImageAsChild(element)) {
      // We use a div in this case, since our image renderer resize functionality
      // (via the re-resizer packages) uses divs, and divs are not allowed inside
      // of paragraphs.
      return (
        <div {...attributes}>
          <span style={{ textIndent: 0 }}>{children}</span>
        </div>
      );
    }

    // Normal paragraph rendering.
    return (
      <p {...attributes}>
        <span style={{ textIndent: 0 }}>{children}</span>
      </p>
    );

    /*
    // I wish I could just use a div instead of a p because
    // you can't have
    // any div's inside of a p, and things like image resize use
    // div's under the hood in the implementation.
    // However, there are rules (e.g., from bootstrap's type.less)
    // like this
    // blockquote {... p { &:last-child { margin-bottom: 0; } }
    // so, e.g., a paragraph in a quote doesn't have that extra
    // bottom margin.  That's a lot more work to re-implement
    // using a div...
    return (
      <div {...attributes} style={{ marginBottom: "1em" }}>
        {children}
      </div>
    );
    */
  },

  fromSlate: ({ node, children, info }) => {
    if (children.trim() == "") {
      // We discard empty paragraphs entirely, unless they were explicitly
      // encoded as blank lines in markdown.
      return node["blank"] ? "\n" : "";
    }

    // trimLeft is because prettier (say) strips whitespace from beginning of paragraphs.
    const s = children.trimLeft() + "\n";
    if (info.lastChild || info.parent?.type == "list_item") return s;
    return s + "\n";
  },
});

function hasImageAsChild(element): boolean {
  for (const x of element.children) {
    if (x["type"] == "image") return true;
  }
  return false;
}
