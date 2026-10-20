/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const conditionAlert = jest.fn(async (_opts: any) => {});
const conditionCleared = jest.fn(async (_subject: string) => {});
jest.mock("./condition-alert", () => ({
  ...jest.requireActual("./condition-alert"),
  conditionAlert: (opts: any) => conditionAlert(opts),
  conditionCleared: (subject: string) => conditionCleared(subject),
}));

import { _test } from "./availability";

test("a pass with only suppressed stale hosts clears the escalated condition", async () => {
  const host = {
    id: "host-1",
    status: "running",
    metadata: { name: "montreal-1" },
    last_seen: new Date(0),
  } as any;
  // alerted, then a pass where every stale host is still being remediated,
  // then the same escalation again: the last one is a recurrence.
  await _test.reportRunningStaleCondition([host]);
  await _test.reportRunningStaleCondition([]);
  await _test.reportRunningStaleCondition([host]);
  expect(conditionAlert).toHaveBeenCalledTimes(2);
  expect(conditionCleared).toHaveBeenCalledTimes(1);
  expect(conditionCleared).toHaveBeenCalledWith(
    "Running project hosts remain unresponsive after remediation",
  );
  expect(conditionCleared.mock.invocationCallOrder[0]).toBeLessThan(
    conditionAlert.mock.invocationCallOrder[1],
  );
});
