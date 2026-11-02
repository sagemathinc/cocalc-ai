/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/frame/relay", () => ({
  WidgetRelay: class WidgetRelay {},
}));

import { JupyterActions } from "../browser-actions";

// Runtime state changes on every state transition of every cell, so the
// browser recomputes run progress on a debounce rather than per change.

function createActions() {
  const actions = new JupyterActions("run-progress-debounce-test", {
    getStore: () => undefined,
  } as any) as any;
  actions._state = "ready";
  actions.updateRunProgress = jest.fn();
  return actions;
}

describe("JupyterActions run progress debounce", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("coalesces a burst of runtime state changes", () => {
    const actions = createActions();

    actions.__runtime_state_change_post_hook();
    actions.__runtime_state_change_post_hook();
    actions.__runtime_state_change_post_hook();
    expect(actions.updateRunProgress).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);

    expect(actions.updateRunProgress).toHaveBeenCalledTimes(1);
  });

  it("still fires while cells keep transitioning faster than the debounce", () => {
    const actions = createActions();

    // A run-all of fast cells never pauses long enough for a trailing-only
    // debounce, which would leave the meter frozen until the run ended.
    for (let i = 0; i < 10; i++) {
      actions.__runtime_state_change_post_hook();
      jest.advanceTimersByTime(300);
    }

    expect(actions.updateRunProgress).toHaveBeenCalled();
  });

  it("drops a pending recompute on close", () => {
    const actions = createActions();

    actions.__runtime_state_change_post_hook();
    actions.close_client_only();
    jest.advanceTimersByTime(2000);

    expect(actions.updateRunProgress).not.toHaveBeenCalled();
  });
});
