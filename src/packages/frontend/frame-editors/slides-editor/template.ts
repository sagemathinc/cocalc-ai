/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Element } from "../whiteboard-editor/types";

type TemplateElement = Omit<Element, "page">;

const TEXT_BOX_WIDTH = 847;
const TEXT_BOX_X = -TEXT_BOX_WIDTH / 2;

export const SLIDE_TEMPLATE_ELEMENTS: ReadonlyArray<TemplateElement> = [
  {
    data: {
      color: "#9f9f9f",
      fontSize: 65,
      placeholder: "Click to edit title",
    },
    h: 123,
    id: "be9e3736",
    type: "text",
    w: TEXT_BOX_WIDTH,
    x: TEXT_BOX_X,
    y: -220,
    z: 0,
  },
  {
    data: {
      color: "#525252",
      fontSize: 36,
      placeholder: "Click to edit subtitle",
    },
    h: 110,
    id: "cdf12aea",
    type: "text",
    w: TEXT_BOX_WIDTH,
    x: TEXT_BOX_X,
    y: -100,
    z: 1,
  },
] as const;
