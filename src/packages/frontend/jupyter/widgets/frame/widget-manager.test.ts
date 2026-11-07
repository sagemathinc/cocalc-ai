/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

let provider: any;
const library: any = {};
jest.mock("@jupyter-widgets/base", () => ({
  WidgetModel: class WidgetModel {},
  DOMWidgetModel: class DOMWidgetModel {},
}));
jest.mock("@cocalc/widgets", () => ({
  createWidgetManager: (env: any) => {
    provider = env;
    return library;
  },
  is_unpack_models: () => false,
}));

import { WidgetManager } from "./widget-manager";

function makeState() {
  const state: any = new EventEmitter();
  state.get_state = () => "ready";
  state.keys = () => [];
  state.getSerializedModelState = () => ({
    _model_name: "IntSliderModel",
    _model_module: "@jupyter-widgets/controls",
    _model_module_version: "2.0.0",
  });
  state.getModelBuffers = async () => ({ buffer_paths: [], buffers: [] });
  return state;
}

describe("the widget frame's manager", () => {
  it("sends comm messages through its host (the frame's port), not the app", async () => {
    const host = {
      sendCommMessageToKernel: jest.fn(),
      renderOutput: jest.fn(),
    };
    new WidgetManager({ ipywidgets_state: makeState(), host });
    const comm = await provider.openCommChannel({
      comm_id: "m1",
      target_name: "jupyter.widget",
    });
    comm.send({ method: "custom", content: { x: 1 } });
    expect(host.sendCommMessageToKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        comm_id: "m1",
        target_name: "jupyter.widget",
        data: { method: "custom", content: { x: 1 } },
      }),
    );
  });

  it("renders Output widget content with the frame's renderer", async () => {
    const host = {
      sendCommMessageToKernel: jest.fn(),
      renderOutput: jest.fn(),
    };
    new WidgetManager({ ipywidgets_state: makeState(), host });
    const div = document.createElement("div");
    const output = { output_type: "stream", name: "stdout", text: "hi" };
    await provider.renderOutput(output, div);
    expect(host.renderOutput).toHaveBeenCalledWith(output, div);
  });

  it("stops sending once closed", async () => {
    const host = {
      sendCommMessageToKernel: jest.fn(),
      renderOutput: jest.fn(),
    };
    const manager = new WidgetManager({ ipywidgets_state: makeState(), host });
    const comm = await provider.openCommChannel({
      comm_id: "m1",
      target_name: "jupyter.widget",
    });
    manager.close();
    expect(() => comm.send({ method: "custom", content: {} })).toThrow();
    expect(host.sendCommMessageToKernel).not.toHaveBeenCalled();
  });
});
