/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { cocalcAccessGuidance } from "../cocalc-access-guidance";
import { harnessSessionGuidance } from "../harness-context";

test("Claude sessions explain how to use CoCalc connector access, like Codex", () => {
  for (const subscription of [true, false]) {
    const guidance = harnessSessionGuidance(subscription);
    expect(guidance).toContain(
      cocalcAccessGuidance(
        '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
      ),
    );
    expect(guidance).toContain(
      "Do not read, print, or copy the connector credential file",
    );
  }
});
