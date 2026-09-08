/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { createIntl, createIntlCache } from "react-intl";
import { frameLayout } from "./frames";
const intl = createIntl({ locale: "en", messages: {} }, createIntlCache());
const leaf = (id: string) => ({ id, type: "cm", path: `${id}.tex` });
it("preserves n-ary geometry and includes hidden tabbed frames in stable order", () => {
  const tree = fromJS({
    type: "node",
    direction: "row",
    sizes: [0.2, 0.3, 0.5],
    children: [
      leaf("a"),
      { type: "tabs", activeTab: 1, children: [leaf("b"), leaf("c")] },
      leaf("d"),
    ],
  });
  const result = frameLayout(tree, undefined, intl);
  expect(result.frames.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
  expect(result.layout?.sizes).toEqual([0.2, 0.3, 0.5]);
  expect(result.layout?.children?.[1].tabs).toBe(true);
});
it("supports legacy binary layouts", () => {
  const result = frameLayout(
    { type: "node", pos: 0.3, first: leaf("a"), second: leaf("b") },
    undefined,
    intl,
  );
  expect(result.frames.map((f) => f.path)).toEqual(["a.tex", "b.tex"]);
  expect(result.layout?.sizes).toEqual([0.3, 0.7]);
});
