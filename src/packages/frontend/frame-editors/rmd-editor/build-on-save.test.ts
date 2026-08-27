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
  const store =
    account == null
      ? undefined
      : {
          get: (field: string) => account[field],
          waitUntilReady: jest.fn(async () => !!account.is_ready),
        };
  actions._state = "open";
  actions.redux = { getStore: () => store };
  return { actions, store, account };
}

function bareActions(Cls: any, account: any) {
  return makeActions(Cls, account).actions;
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
    const actions = bareActions(Cls, {
      is_ready: false,
      editor_settings: iMap({ build_on_save: true }),
    });
    expect(doBuildOnSave(Cls, actions)).toBe(false);
  });

  it("is false when editor_settings is null", () => {
    const actions = bareActions(Cls, {
      is_ready: true,
      editor_settings: null,
    });
    expect(doBuildOnSave(Cls, actions)).toBe(false);
  });

  it("is false when there is no account store", () => {
    expect(doBuildOnSave(Cls, bareActions(Cls, null))).toBe(false);
  });

  it("follows the user setting once loaded", () => {
    const on = bareActions(Cls, {
      is_ready: true,
      editor_settings: iMap({ build_on_save: true }),
    });
    expect(doBuildOnSave(Cls, on)).toBe(true);
    const off = bareActions(Cls, {
      is_ready: true,
      editor_settings: iMap({ build_on_save: false }),
    });
    expect(doBuildOnSave(Cls, off)).toBe(false);
  });

  it("defaults to true when the setting is absent but settings are loaded", () => {
    const actions = bareActions(Cls, {
      is_ready: true,
      editor_settings: iMap({}),
    });
    expect(doBuildOnSave(Cls, actions)).toBe(true);
  });
});

describe.each([
  ["R Markdown", RmdActions],
  ["Quarto", QmdActions],
])("%s waitForBuildOnSave", (_name, Cls: any) => {
  function waitForBuildOnSave(actions: any): Promise<boolean> {
    return (Cls.prototype as any).waitForBuildOnSave.call(actions);
  }

  it("waits for the account settings instead of dropping the save", async () => {
    // A save that lands before the account snapshot must not be discarded:
    // the source on disk is already newer than the output, and there may
    // never be another edit to retrigger the build.
    const acct: any = {
      is_ready: false,
      editor_settings: iMap({ build_on_save: true }),
    };
    const { actions, store } = makeActions(Cls, acct);
    store!.waitUntilReady = jest.fn(async () => {
      acct.is_ready = true;
      return true;
    });
    expect(await waitForBuildOnSave(actions)).toBe(true);
    expect(store!.waitUntilReady).toHaveBeenCalled();
  });

  it("does not wait once the settings are loaded", async () => {
    const { actions, store } = makeActions(Cls, {
      is_ready: true,
      editor_settings: iMap({ build_on_save: true }),
    });
    expect(await waitForBuildOnSave(actions)).toBe(true);
    expect(store!.waitUntilReady).not.toHaveBeenCalled();
  });

  it("honours a disabled setting that only arrives later", async () => {
    const acct: any = { is_ready: false, editor_settings: null };
    const { actions, store } = makeActions(Cls, acct);
    store!.waitUntilReady = jest.fn(async () => {
      acct.is_ready = true;
      acct.editor_settings = iMap({ build_on_save: false });
      return true;
    });
    expect(await waitForBuildOnSave(actions)).toBe(false);
  });

  it("gives up when readiness times out", async () => {
    const { actions, store } = makeActions(Cls, {
      is_ready: false,
      editor_settings: iMap({ build_on_save: true }),
    });
    store!.waitUntilReady = jest.fn(async () => false);
    expect(await waitForBuildOnSave(actions)).toBe(false);
  });

  it("gives up when the editor closed while waiting", async () => {
    const acct: any = {
      is_ready: false,
      editor_settings: iMap({ build_on_save: true }),
    };
    const { actions, store } = makeActions(Cls, acct);
    store!.waitUntilReady = jest.fn(async () => {
      acct.is_ready = true;
      actions._state = "closed";
      return true;
    });
    expect(await waitForBuildOnSave(actions)).toBe(false);
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
