/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

// The exported document is parsed as HTML (a download, or the print popup of
// the app's origin), so any script element in it would run.

import exportToHTML from "./export";

it("exported notebook HTML contains no script from the notebook", () => {
  const doc = exportToHTML({
    title: "t",
    cocalcJupyter: {
      cellList: ["a"],
      cells: {
        a: {
          id: "a",
          cell_type: "code",
          input: "x",
          output: {
            0: {
              data: {
                "text/html":
                  '<b>kept</b><script>window.ranFromOutput = 1</script><a href="javascript:alert(1)">link</a>',
              },
            },
          },
        },
      },
      kernelspec: {
        name: "python3",
        display_name: "Python 3",
        language: "python",
      },
    },
  });
  expect(doc).toContain("<b>kept</b>");
  expect(doc).not.toContain("ranFromOutput");
  expect(doc).not.toMatch(/="\s*javascript:/i);
});
