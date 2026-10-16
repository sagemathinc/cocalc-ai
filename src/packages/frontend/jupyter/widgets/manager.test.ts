/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

const models: { [id: string]: any } = {};
let provider: any;
// The widget library's code-activation entry points.
const library: any = {};
function resetLibrary() {
  Object.assign(library, {
    _models: models,
    get_model: jest.fn(async (id: string) => models[id]),
    register_model: jest.fn(),
    loadClass: jest.fn(async () => class Widget {}),
    new_model: jest.fn(async () => ({})),
    create_view: jest.fn(async () => ({})),
    render: jest.fn(async () => {}),
  });
}
resetLibrary();
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
jest.mock("@cocalc/frontend/jupyter/output-messages/message", () => ({
  CellOutputMessage: () => null,
}));
jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => () => null,
}));

import { WidgetManager } from "./manager";

function makeState() {
  const state: any = new EventEmitter();
  state.get_state = () => "ready";
  state.keys = () => [];
  state.getSerializedModelState = () => ({
    _model_name: "CustomModel",
    _model_module: "custom-widgets",
    _model_module_version: "1.0.0",
  });
  state.getModelBuffers = async () => ({ buffer_paths: [], buffers: [] });
  return state;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WidgetManager.close", () => {
  beforeEach(() => {
    for (const id of Object.keys(models)) delete models[id];
    resetLibrary();
  });

  it("stops applying state, closes every model and refuses kernel messages", async () => {
    const state = makeState();
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
    await tick();
    expect(model.close).toHaveBeenCalledWith(true);
    expect(() => comm.send({ x: 1 })).toThrow(/not trusted/);
    expect(sendCommMessageToKernel).not.toHaveBeenCalled();
    // Closing twice is harmless.
    manager.close();
  });

  it("aborts model hydration that was in flight when trust was lost", async () => {
    const state = makeState();
    let releaseBuffers: (x: any) => void = () => {};
    state.getModelBuffers = () =>
      new Promise((resolve) => {
        releaseBuffers = resolve;
      });
    const manager = new WidgetManager({
      ipywidgets_state: state,
      actions: { sendCommMessageToKernel: jest.fn() } as any,
    });
    // The widget library asks for the model's state, then opens its comm,
    // then constructs the model (loading its module).
    const hydration = provider.getSerializedModelState("m1");
    await tick();
    manager.close();
    releaseBuffers({ buffer_paths: [], buffers: [] });
    await expect(hydration).rejects.toThrow(/not trusted/);
    await expect(
      provider.openCommChannel({
        comm_id: "c1",
        target_name: "jupyter.widget",
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it("closes models that register after close()", async () => {
    const manager = new WidgetManager({
      ipywidgets_state: makeState(),
      actions: { sendCommMessageToKernel: jest.fn() } as any,
    });
    manager.close();
    const late = { close: jest.fn() };
    (manager.manager as any).register_model("m2", Promise.resolve(late));
    await tick();
    expect(late.close).toHaveBeenCalledWith(true);
  });

  it("does not render nested output after close()", async () => {
    const manager = new WidgetManager({
      ipywidgets_state: makeState(),
      actions: {
        sendCommMessageToKernel: jest.fn(),
        store: { get: () => true },
      } as any,
    });
    manager.close();
    const destination = document.createElement("div");
    await provider.renderOutput({ output_type: "stream" }, destination);
    expect(destination.childNodes.length).toBe(0);
  });

  it("starts no widget code after close()", async () => {
    const originals = {
      loadClass: library.loadClass,
      new_model: library.new_model,
      create_view: library.create_view,
      render: library.render,
    };
    const manager = new WidgetManager({
      ipywidgets_state: makeState(),
      actions: { sendCommMessageToKernel: jest.fn() } as any,
    });
    const lib: any = manager.manager;
    // While open, calls go through.
    await lib.loadClass("IntSliderModel", "@jupyter-widgets/controls", "2");
    expect(originals.loadClass).toHaveBeenCalledTimes(1);
    manager.close();
    for (const name of Object.keys(originals)) {
      await expect(lib[name]("x")).rejects.toThrow(/not trusted/);
      expect(originals[name]).toHaveBeenCalledTimes(
        name == "loadClass" ? 1 : 0,
      );
    }
  });

  it("refuses a class that finishes loading after close(), so it is never constructed", async () => {
    let release: (cls: any) => void = () => {};
    library.loadClass = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const manager = new WidgetManager({
      ipywidgets_state: makeState(),
      actions: { sendCommMessageToKernel: jest.fn() } as any,
    });
    const constructed = jest.fn();
    const loading = (manager.manager as any).loadClass(
      "CustomView",
      "custom",
      "1",
    );
    manager.close();
    release(
      class CustomView {
        constructor() {
          constructed();
        }
      },
    );
    await expect(loading).rejects.toThrow(/not trusted/);
    expect(constructed).not.toHaveBeenCalled();
  });

  it("unmounts nested output on close()", async () => {
    const manager = new WidgetManager({
      ipywidgets_state: makeState(),
      actions: {
        sendCommMessageToKernel: jest.fn(),
        store: { get: () => true },
      } as any,
    });
    await provider.renderOutput(
      { output_type: "stream", name: "stdout", text: "hi" },
      document.createElement("div"),
    );
    expect(manager.outputRoots.size).toBe(1);
    const [root] = manager.outputRoots;
    const unmount = jest.spyOn(root, "unmount");
    manager.close();
    expect(unmount).toHaveBeenCalled();
    expect(manager.outputRoots.size).toBe(0);
  });
});
