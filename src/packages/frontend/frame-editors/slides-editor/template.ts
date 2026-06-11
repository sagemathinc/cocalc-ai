/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Element } from "../whiteboard-editor/types";

type TemplateElement = Omit<Element, "page">;

const TEXT_BOX_WIDTH = 847;
const TEXT_BOX_X = -200;

export const SLIDE_TEMPLATE_ELEMENTS: ReadonlyArray<TemplateElement> = [
  {
    data: {
      color: "#252937",
      fontSize: 24,
      initStr: "\n# \n",
      placeholder: "# Click to edit title\n\n",
    },
    h: 121,
    id: "be9e3736",
    type: "text",
    w: TEXT_BOX_WIDTH,
    x: TEXT_BOX_X,
    y: -492,
    z: 0,
  },
  {
    data: {
      color: "#525252",
      fontSize: 18,
      initStr: "\n## \n",
      placeholder: "## Click to edit subtitle\n\n",
    },
    h: 95,
    id: "cdf12aea",
    type: "text",
    w: TEXT_BOX_WIDTH,
    x: TEXT_BOX_X,
    y: -393,
    z: 1,
  },
] as const;
