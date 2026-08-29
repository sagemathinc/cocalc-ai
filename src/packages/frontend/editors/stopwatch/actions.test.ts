/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { TimeActions } from "./actions";

test("a rejected fire-and-forget save is shown as an editor error", async () => {
  const redux = {
    getStore: jest.fn(() => ({})),
    _set_state: jest.fn(),
  };
  const actions = new TimeActions("stopwatch-test", redux as any);
  actions._init("project-1", "timer.stopwatch");
  actions.syncdb = {
    set: jest.fn(),
    commit: jest.fn(),
    save_to_disk: jest
      .fn()
      .mockRejectedValue(new Error("collaborative history is not up to date")),
    isClosed: jest.fn(() => false),
  };

  actions.startStopwatch(1);
  await Promise.resolve();
  await Promise.resolve();

  expect(redux._set_state).toHaveBeenLastCalledWith(
    {
      "stopwatch-test": {
        error: expect.stringContaining("collaborative history"),
      },
    },
    "stopwatch-test",
  );
});
