/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Register the subset of Slate element types needed for public markdown
// viewing without bringing in notebook-only or editor-only renderers.

import "./blockquote";
import "./break";
import "./checkbox";
import "./code-block/public-viewer";
import "./details";
import "./emoji";
import "./generic";
import "./hashtag";
import "./heading";
import "./html";
import "./hr";
import "./image";
import "./link";
import "./list";
import "./list/list-item";
import "./math";
import "./mention";
import "./meta";
import "./paragraph";
import "./references";
import "./table";

import { Element } from "slate";

export function isElementOfType(x, type: string | string[]): boolean {
  return (
    Element.isElement(x) &&
    ((typeof type == "string" && x["type"] == type) ||
      (typeof type != "string" && type.indexOf(x["type"]) != -1))
  );
}
