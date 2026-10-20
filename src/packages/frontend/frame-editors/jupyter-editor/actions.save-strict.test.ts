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

// A notebook save failure is shown in the editor and otherwise swallowed;
// with strict (used before course assign) it must also reach the caller.
function notebook(save: () => Promise<void>) {
  const errors: string[] = [];
  const target: any = {
    _state: "ready",
    jupyter_actions: { hasPendingIpynbChanges: () => true, save },
    _active_id: () => "frame",
    get_frame_actions: () => undefined,
    setState: () => undefined,
    set_error: (err: string) => errors.push(err),
  };
  const run: any = (opts?: { strict?: boolean }) =>
    JupyterEditorActions.prototype.save.call(target, true, opts);
  run.target = target;
  return { run, errors };
}

describe("JupyterEditorActions.save strict mode", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("reports but swallows a failed save by default", async () => {
    const { run, errors } = notebook(async () => {
      throw Error("write failed");
    });
    await expect(run()).resolves.toBeUndefined();
    expect(errors.join()).toContain("write failed");
  });

  it("reports and throws a failed save when strict", async () => {
    const { run, errors } = notebook(async () => {
      throw Error("write failed");
    });
    await expect(run({ strict: true })).rejects.toThrow("write failed");
    expect(errors.join()).toContain("write failed");
  });

  it("still throws when strict if the editor closes before the save fails", async () => {
    let target: any;
    const { run, errors } = notebook(async () => {
      target._state = "closed";
      throw Error("write failed");
    });
    target = (run as any).target;
    await expect(run({ strict: true })).rejects.toThrow("write failed");
    expect(errors).toEqual([]);
  });
});
