/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { act, render, waitFor } from "@testing-library/react";
import { Map } from "immutable";
import { IpyWidget } from "../ipywidget";

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ isVisible: true }),
}));

describe("IpyWidget initialization", () => {
  it("renders and cleans up widgets without a global jQuery", async () => {
    jest.useFakeTimers();
    const previous = globalThis.$;
    delete (globalThis as any).$;
    const renderWidget = jest.fn(async () => {});
    const actions = {
      widget_manager: {
        ipywidgets_state: {
          get_state: () => "ready",
          getSerializedModelState: () => ({ _model_name: "IntSliderModel" }),
        },
        manager: { render: renderWidget },
      },
    };
    try {
      const { unmount } = render(
        <IpyWidget
          value={Map({ model_id: "model-1" })}
          actions={actions as any}
        />,
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1100);
      });
      expect(renderWidget).toHaveBeenCalledTimes(1);
      // Includes the delayed KaTeX callback, which formerly used global $.
      await act(async () => {
        await jest.runOnlyPendingTimersAsync();
      });
      expect(() => unmount()).not.toThrow();
    } finally {
      globalThis.$ = previous;
      jest.useRealTimers();
    }
  });

  it("waits for widget state readiness before serializing a model", async () => {
    const state = new EventEmitter() as EventEmitter & {
      get_state: () => "init" | "ready";
      getSerializedModelState: jest.Mock;
    };
    let currentState: "init" | "ready" = "init";
    state.get_state = () => currentState;
    state.getSerializedModelState = jest.fn(() => ({
      _model_name: "IntSliderModel",
    }));
    const actions = {
      widget_manager: {
        ipywidgets_state: state,
      },
    };

    render(
      <IpyWidget
        value={Map({ model_id: "model-1" })}
        actions={actions as any}
      />,
    );

    expect(state.getSerializedModelState).not.toHaveBeenCalled();

    await act(async () => {
      currentState = "ready";
      state.emit("ready");
    });

    await waitFor(() => {
      expect(state.getSerializedModelState).toHaveBeenCalledWith("model-1");
    });
  });
});
