/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { act, render, screen } from "@testing-library/react";
import { Map } from "immutable";
import { IpyWidget } from "../ipywidget";

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ isVisible: true }),
}));

// The frame itself is tested in widgets/frame/.
jest.mock("../../widgets/frame/widget-frame", () => ({
  WidgetFrame: ({ model_id, relay }) => (
    <div
      data-testid="widget-frame"
      data-model={model_id}
      data-relay={relay.id}
    />
  ),
}));

function makeState(known: boolean, ready = true) {
  const state = new EventEmitter() as any;
  state.current = ready ? "ready" : "init";
  state.known = known;
  state.get_state = () => state.current;
  state.getSerializedModelState = jest.fn(() =>
    state.current === "ready" && state.known
      ? { _model_name: "IntSliderModel" }
      : undefined,
  );
  return state;
}

function makeActions(state) {
  const relay = { id: "relay-1" };
  return {
    syncdb: { ipywidgets_state: state },
    widgetRelay: jest.fn(() => relay),
    runCells: jest.fn(),
  };
}

describe("IpyWidget", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("renders the widget in a frame, never in the page, trusted or not", async () => {
    const actions = makeActions(makeState(true));
    render(
      <IpyWidget
        value={Map({ model_id: "model-1" })}
        actions={actions as any}
        trust={false}
      />,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const frame = screen.getByTestId("widget-frame");
    expect(frame.getAttribute("data-model")).toBe("model-1");
    expect(frame.getAttribute("data-relay")).toBe("relay-1");
    expect(document.querySelector(".widget-slider")).toBeNull();
  });

  it("waits for the widget state before rendering", async () => {
    const state = makeState(true, false);
    const actions = makeActions(state);
    render(
      <IpyWidget
        value={Map({ model_id: "model-1" })}
        actions={actions as any}
      />,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByTestId("widget-frame")).toBeNull();
    state.current = "ready";
    await act(async () => {
      state.emit("ready");
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("widget-frame")).toBeTruthy();
  });

  it("offers to run the cell when the model never arrives", async () => {
    const actions = makeActions(makeState(false));
    render(
      <IpyWidget
        id="cell-1"
        value={Map({ model_id: "model-1" })}
        actions={actions as any}
      />,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6000);
    });
    expect(screen.queryByTestId("widget-frame")).toBeNull();
    expect(screen.getByText("Run cell to load widget")).toBeTruthy();
  });
});
