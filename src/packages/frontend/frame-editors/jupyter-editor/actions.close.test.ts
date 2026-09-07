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
import { fromJS } from "immutable";
import { hasNbgraderMetadata } from "./nbgrader-layout";

describe("nbgrader frame restrictions", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    undefined,
    {},
    { store: undefined },
    { store: { get: () => undefined } },
  ])(
    "keeps Studio unavailable when notebook metadata is missing: %p",
    (jupyter_actions) => {
      expect(
        JupyterEditorActions.prototype.studioUnavailableReason.call({
          jupyter_actions,
        } as any),
      ).toBe("Notebook metadata is still loading.");
    },
  );

  it("handles a store removed during teardown without relaxing nbgrader restrictions", () => {
    const target = { jupyter_actions: { store: { get: jest.fn() } } } as any;
    const reason = () =>
      JupyterEditorActions.prototype.studioUnavailableReason.call(target);
    target.jupyter_actions.store.get.mockReturnValue(fromJS({}));
    expect(reason()).toBeUndefined();
    target.jupyter_actions.store.get.mockReturnValue(
      fromJS({ a: { metadata: { nbgrader: { points: 10 } } } }),
    );
    expect(reason()).toBeTruthy();
    delete target.jupyter_actions.store;
    expect(reason()).toBe("Notebook metadata is still loading.");
  });

  it("guards new split frames and permits Studio on ordinary notebooks", () => {
    const base = jest
      .spyOn(BaseEditorActions.prototype, "new_frame")
      .mockReturnValue("new");
    const target = {
      studioUnavailableReason: jest.fn(() => "nbgrader"),
    } as any;
    expect(
      JupyterEditorActions.prototype.new_frame.call(
        target,
        "jupyter_studio",
        "row",
        true,
      ),
    ).toBe("new");
    expect(base).toHaveBeenLastCalledWith("jupyter_cell_notebook", "row", true);
    target.studioUnavailableReason.mockReturnValue(undefined);
    JupyterEditorActions.prototype.new_frame.call(target, "jupyter_studio");
    expect(base).toHaveBeenLastCalledWith("jupyter_studio");
  });
  it("guards direct Studio requests without changing other frame types", () => {
    const base = jest
      .spyOn(BaseEditorActions.prototype, "set_frame_type")
      .mockImplementation(() => {});
    const target = { studioUnavailableReason: () => "nbgrader" } as any;
    JupyterEditorActions.prototype.set_frame_type.call(
      target,
      "frame",
      "jupyter_studio",
    );
    expect(base).toHaveBeenLastCalledWith("frame", "jupyter_cell_notebook");
    JupyterEditorActions.prototype.set_frame_type.call(
      target,
      "frame",
      "terminal",
    );
    expect(base).toHaveBeenLastCalledWith("frame", "terminal");
  });
  it("converts only Studio frames when assignment metadata arrives", () => {
    const cells = fromJS({ a: { metadata: { nbgrader: { points: 10 } } } });
    expect(hasNbgraderMetadata(cells)).toBe(true);
    const target = {
      jupyter_actions: { store: { get: () => cells } },
      store: { get: () => false },
      setState: jest.fn(),
      _get_leaf_ids: () => ({ studio: true, terminal: true }),
      _get_frame_type: (id) =>
        id === "studio" ? "jupyter_studio" : "terminal",
      set_frame_type: jest.fn(),
    };
    (JupyterEditorActions.prototype as any).enforceNbgraderLayout.call(target);
    expect(target.set_frame_type.mock.calls).toEqual([
      ["studio", "jupyter_cell_notebook"],
    ]);
    expect(target.setState).toHaveBeenCalledWith({ has_nbgrader: true });
  });
});

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

  it("provides AI metadata defaults after Jupyter actions are removed", () => {
    const target = { jupyter_actions: undefined } as any;

    expect(
      JupyterEditorActions.prototype.languageModelGetLanguage.call(target),
    ).toBe("py");
    expect(
      JupyterEditorActions.prototype.languageModelExtraFileInfo.call(target),
    ).toBe("Jupyter notebook using the  kernel");
    expect(
      JupyterEditorActions.prototype.codexCodeDescription.call(target),
    ).toBe("Jupyter notebook using the  kernel");
  });
});

describe("JupyterEditorActions close-frame cleanup", () => {
  it("closes the notebook frame action synchronously before closing the file tab", () => {
    const store = new EventEmitter();
    const close = jest.fn();
    const target = {
      normalizeRemovedFrameTypes: jest.fn(),
      init_new_frame: jest.fn(),
      init_changes_state: jest.fn(),
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

describe("JupyterEditorActions removed frame type migration", () => {
  function targetFor(nodes: { [id: string]: { [key: string]: any } }): any {
    return {
      _get_leaf_ids: () => nodes,
      _get_frame_node: (id: string) => ({
        get: (key: string) => nodes[id][key],
      }),
      set_frame_type: jest.fn(),
      set_frame_data: jest.fn(),
    };
  }

  function migrate(target: any): void {
    (JupyterEditorActions.prototype as any).normalizeRemovedFrameTypes.call(
      target,
    );
  }

  it("converts saved experimental frames to the standard notebook", () => {
    const target = targetFor({
      classic: { type: "jupyter_cell_notebook" },
      experimental: { type: "jupyter_slate_single_doc_notebook" },
      legacy: { type: "jupyter-singledoc" },
    });

    migrate(target);

    expect(target.set_frame_type.mock.calls).toEqual([
      ["experimental", "jupyter_cell_notebook"],
      ["legacy", "jupyter_cell_notebook"],
    ]);
  });

  it("converts a saved Minimal frame to Studio instead of resetting the tree", () => {
    const target = targetFor({
      terminal: { type: "terminal" },
      renamed: { type: "jupyter_minimal" },
    });

    migrate(target);

    // Only the stale frame is touched, so the surrounding layout survives.
    expect(target.set_frame_type.mock.calls).toEqual([
      ["renamed", "jupyter_studio"],
    ]);
  });

  it("carries the saved width and reading state across the rename", () => {
    const target = targetFor({
      renamed: {
        type: "jupyter_minimal",
        "data-minimalLayout": "narrow",
        "data-zenMode": true,
      },
    });

    migrate(target);

    expect(target.set_frame_data).toHaveBeenCalledWith({
      id: "renamed",
      studioLayout: "narrow",
      readingMode: true,
    });
  });

  it("does not invent frame data the saved frame never had", () => {
    const target = targetFor({ renamed: { type: "jupyter_minimal" } });

    migrate(target);

    expect(target.set_frame_data).not.toHaveBeenCalled();
    expect(target.set_frame_type).toHaveBeenCalledWith(
      "renamed",
      "jupyter_studio",
    );
  });
});
