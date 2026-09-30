/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { cocalcAccessGuidance } from "../cocalc-access-guidance";
import { harnessPrompt } from "../harness-context";

test("Claude turns explain how to use CoCalc connector access, like Codex", () => {
  const prompt = harnessPrompt({
    prompt: "List my other projects.",
    project_id: "00000000-0000-4000-8000-000000000001",
    chat: {
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "a.chat",
      thread_id: "thread-1",
      message_date: "2026-09-30T00:00:00.000Z",
    },
  } as any);
  expect(prompt).toContain(
    cocalcAccessGuidance(
      '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"',
    ),
  );
  expect(prompt).toContain(
    "Do not read, print, or copy the connector credential file",
  );
});
