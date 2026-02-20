/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register } from "./register";

register(
  [
    { key: "Enter", alt: true },
    { key: "Enter", meta: true },
  ],
  ({ editor, extra }) => {
    const altEnter = extra?.actions?.altEnter;
    if (altEnter != null) {
      altEnter(editor.getMarkdownValue(), extra?.id, {
        selection: editor.selection ?? null,
        slateValue: [...editor.children] as any,
      });
      return true;
    }
    editor.inverseSearch(true);
    return true;
  }
);
