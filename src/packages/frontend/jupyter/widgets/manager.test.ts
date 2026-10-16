/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

const models: { [id: string]: any } = {};
jest.mock("@jupyter-widgets/base", () => ({
  WidgetModel: class WidgetModel {},
  DOMWidgetModel: class DOMWidgetModel {},
}));
jest.mock("@cocalc/widgets", () => ({
  createWidgetManager: () => ({
    _models: models,
    get_model: jest.fn(async (id: string) => models[id]),
  }),
  is_unpack_models: () => false,
}));
jest.mock("@cocalc/frontend/jupyter/output-messages/message", () => ({
  CellOutputMessage: () => null,
}));
jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => () => null,
}));

import { WidgetManager } from "./manager";

describe("WidgetManager.close", () => {
  it("stops applying state, closes every model and refuses kernel messages", async () => {
    const state: any = new EventEmitter();
    state.get_state = () => "ready";
    state.keys = () => [];
    const model = { close: jest.fn() };
    models["m1"] = Promise.resolve(model);
    const sendCommMessageToKernel = jest.fn();
    const manager = new WidgetManager({
      ipywidgets_state: state,
      actions: { sendCommMessageToKernel } as any,
    });
    const comm = await manager.openCommChannel({
      comm_id: "c1",
      target_name: "jupyter.widget",
    });

    expect(state.listenerCount("change")).toBe(1);
    manager.close();
    expect(manager.isClosed()).toBe(true);
    expect(state.listenerCount("change")).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.close).toHaveBeenCalledWith(true);
    expect(() => comm.send({ x: 1 })).toThrow(/not trusted/);
    expect(sendCommMessageToKernel).not.toHaveBeenCalled();
    // Closing twice is harmless.
    manager.close();
  });
});
