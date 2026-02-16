/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

YAML metadata node, e.g., at the VERY top like this:

---
title: HW02
subtitle: Basic Rmd and Statistics
output:
  html_document:
    theme: spacelab
    highlight: tango
    toc: true
---


*/

import { register } from "../register";
import { Meta, createMetaNode } from "./type";
export type { Meta };
export { createMetaNode };

register({
  slateType: "meta",

  toSlate: ({ token }) => {
    return createMetaNode(token.content);
  },

  StaticElement: ({ attributes, element }) => {
    if (element.type != "meta") throw Error("bug");
    return (
      <div {...attributes}>
        <code>---</code>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {element.value}
        </pre>
        <code>---</code>
      </div>
    );
  },
});
