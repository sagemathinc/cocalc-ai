/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Editors report a failed save in the editor and otherwise swallow it; with
// strict (used before course assign) the failure must also reach the caller.

import { BaseEditorActions } from "@cocalc/frontend/frame-editors/base-editor/actions-base";

function editor(save_to_disk: () => Promise<void>) {
  const errors: string[] = [];
  const target: any = {
    store: { get: (key: string) => key === "is_loaded" || undefined },
    _syncstring: {
      get_state: () => "ready",
      save_to_disk,
      get_string_id: () => "id",
    },
    _state: "ready",
    isClosed: () => false,
    openAnywaysModalIsOpen: false,
    project_id: "project",
    path: "hw.py",
    set_syncstring_to_codemirror: () => undefined,
    setState: () => undefined,
    set_error: (err: string) => errors.push(err),
  };
  const save = (opts?: { strict?: boolean }) =>
    (BaseEditorActions.prototype as any).save.call(target, false, opts);
  return { save, errors, target };
}

describe("BaseEditorActions.save strict mode", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("reports but swallows a failed save by default", async () => {
    const { save, errors } = editor(async () => {
      throw Error("disk full");
    });
    await expect(save()).resolves.toBeUndefined();
    expect(errors.join()).toContain("disk full");
  });

  it("reports and throws a failed save when strict", async () => {
    const { save, errors } = editor(async () => {
      throw Error("disk full");
    });
    await expect(save({ strict: true })).rejects.toThrow("disk full");
    expect(errors.join()).toContain("disk full");
  });

  it("still throws when strict if the editor closes before the save fails", async () => {
    const x = editor(async () => {
      x.target._state = "closed";
      throw Error("disk full");
    });
    await expect(x.save({ strict: true })).rejects.toThrow("disk full");
    expect(x.errors).toEqual([]);
  });

  it("resolves when a strict save succeeds", async () => {
    const save_to_disk = jest.fn(async () => undefined);
    const { save, errors } = editor(save_to_disk);
    await expect(save({ strict: true })).resolves.toBeUndefined();
    expect(save_to_disk).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
});
