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
          trust
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
        trust
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

  it.each([false, undefined])(
    "shows a passive placeholder and touches no widget state when trust is %s",
    async (trust) => {
      const renderWidget = jest.fn(async () => {});
      const getSerializedModelState = jest.fn(() => ({
        _model_name: "HTMLModel",
      }));
      const trustNotebook = jest.fn(async () => {});
      const actions = {
        store: { get: (key: string) => (key == "trust" ? false : undefined) },
        trust_notebook: trustNotebook,
        widget_manager: {
          ipywidgets_state: {
            get_state: () => "ready",
            getSerializedModelState,
          },
          manager: { render: renderWidget },
        },
      };
      const { getByText } = render(
        <IpyWidget
          value={Map({ model_id: "model-1" })}
          actions={actions as any}
          trust={trust}
        />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(
        getByText("Widget not shown because this notebook is not trusted."),
      ).toBeTruthy();
      expect(getSerializedModelState).not.toHaveBeenCalled();
      expect(renderWidget).not.toHaveBeenCalled();
      getByText("Trust notebook...").click();
      expect(trustNotebook).toHaveBeenCalledTimes(1);
    },
  );
});
