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
