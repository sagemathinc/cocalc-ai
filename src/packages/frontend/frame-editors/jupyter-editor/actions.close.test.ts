/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/jupyter/browser-actions", () => ({
  JupyterActions: class {},
}));

jest.mock("./jupyter-actions", () => ({
  create_jupyter_actions: jest.fn(),
  close_jupyter_actions: jest.fn(),
}));

import { EventEmitter } from "events";
import { JupyterEditorActions } from "./actions";
import { BaseEditorActions } from "../base-editor/actions-base";

describe("JupyterEditorActions.close", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("detaches base editor syncdoc recovery before closing jupyter actions", () => {
    const order: string[] = [];
    jest
      .spyOn(BaseEditorActions.prototype, "close")
      .mockImplementation(function (this: any) {
        order.push("base");
      });

    const target = {
      syncConsoleTimer: undefined,
      close_jupyter_actions: jest.fn(() => {
        order.push("jupyter");
      }),
    } as any;

    JupyterEditorActions.prototype.close.call(target);

    expect(order).toEqual(["base", "jupyter"]);
  });
});

describe("JupyterEditorActions close-frame cleanup", () => {
  it("closes the notebook frame action synchronously before closing the file tab", () => {
    const store = new EventEmitter();
    const close = jest.fn();
    const target = {
      init_new_frame: jest.fn(),
      init_changes_state: jest.fn(),
      applyFrameTypeFromUrlForTests: jest.fn(),
      normalizeHiddenSingleDocFrames: jest.fn(),
      store,
      frame_actions: {
        "frame-1": { close },
      },
    } as any;

    JupyterEditorActions.prototype._init2.call(target);

    store.emit("close-frame", { id: "frame-1", closingFile: true });

    expect(close).toHaveBeenCalledTimes(1);
    expect(target.frame_actions["frame-1"]).toBeUndefined();
  });
});
