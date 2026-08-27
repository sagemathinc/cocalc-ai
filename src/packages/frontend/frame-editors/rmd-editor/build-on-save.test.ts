/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map as iMap } from "immutable";

import { Actions as QmdActions } from "../qmd-editor/actions";
import { Actions as RmdActions } from "./actions";
import { checkProducedFiles } from "./utils";

function makeActions(
  Cls: any,
  account: { is_ready?: boolean; editor_settings?: any } | null,
) {
  const actions: any = Object.create(Cls.prototype);
  actions.redux = {
    getStore: () =>
      account == null
        ? undefined
        : {
            get: (field: string) => account[field],
          },
  };
  return actions;
}

function doBuildOnSave(Cls: any, actions: any): boolean {
  return (Cls.prototype as any).do_build_on_save.call(actions);
}

describe.each([
  ["R Markdown", RmdActions],
  ["Quarto", QmdActions],
])("%s do_build_on_save", (_name, Cls: any) => {
  it("is false while the account settings are still loading", () => {
    // The store holds the schema defaults (build_on_save: true) before
    // is_ready fires -- we must not act on those.
    const actions = makeActions(Cls, {
      is_ready: false,
      editor_settings: iMap({ build_on_save: true }),
    });
    expect(doBuildOnSave(Cls, actions)).toBe(false);
  });

  it("is false when editor_settings is null", () => {
    const actions = makeActions(Cls, {
      is_ready: true,
      editor_settings: null,
    });
    expect(doBuildOnSave(Cls, actions)).toBe(false);
  });

  it("is false when there is no account store", () => {
    expect(doBuildOnSave(Cls, makeActions(Cls, null))).toBe(false);
  });

  it("follows the user setting once loaded", () => {
    const on = makeActions(Cls, {
      is_ready: true,
      editor_settings: iMap({ build_on_save: true }),
    });
    expect(doBuildOnSave(Cls, on)).toBe(true);
    const off = makeActions(Cls, {
      is_ready: true,
      editor_settings: iMap({ build_on_save: false }),
    });
    expect(doBuildOnSave(Cls, off)).toBe(false);
  });

  it("defaults to true when the setting is absent but settings are loaded", () => {
    const actions = makeActions(Cls, {
      is_ready: true,
      editor_settings: iMap({}),
    });
    expect(doBuildOnSave(Cls, actions)).toBe(true);
  });
});

describe("checkProducedFiles", () => {
  function makeEditorActions(exists: (path: string) => Promise<boolean>) {
    const setState = jest.fn();
    return {
      setState,
      actions: {
        project_id: "project-1",
        path: "docs/report.Rmd",
        redux: { getProjectActions: () => ({}) },
        fs: () => ({ exists }),
        setState,
      },
    };
  }

  it("reports the produced extensions and updates derived_file_types", async () => {
    const { actions, setState } = makeEditorActions(
      async (p: string) => p === "docs/report.html",
    );
    const result = await checkProducedFiles(actions);
    expect(result?.toJS().sort()).toEqual(["html"]);
    expect(setState).toHaveBeenCalled();
  });

  it("reports an empty set when nothing was produced", async () => {
    const { actions } = makeEditorActions(async () => false);
    const result = await checkProducedFiles(actions);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });

  it("returns null (unknown) when the filesystem is unavailable", async () => {
    const { actions, setState } = makeEditorActions(async () => {
      throw new Error("project not running");
    });
    expect(await checkProducedFiles(actions)).toBeNull();
    // must NOT claim that no output exists
    expect(setState).not.toHaveBeenCalled();
  });

  it("returns null when there are no project actions", async () => {
    const { actions } = makeEditorActions(async () => false);
    (actions.redux as any).getProjectActions = () => null;
    expect(await checkProducedFiles(actions)).toBeNull();
  });
});
