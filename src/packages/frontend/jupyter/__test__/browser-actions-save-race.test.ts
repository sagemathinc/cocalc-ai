/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { sha1 } from "@cocalc/util/misc";
import { JupyterActions } from "../browser-actions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

function createActions() {
  const actions: any = new JupyterActions("jupyter-save-race-test", {
    getStore: jest.fn(() => undefined),
    removeActions: jest.fn(),
  } as any);
  actions._state = "ready";
  actions.path = "race.ipynb";
  actions.isClosed = jest.fn(() => false);
  actions.runDebug = jest.fn();
  actions.setState = jest.fn();
  actions.setToIpynb = jest.fn(async () => {});
  actions.refreshKernelStatus = jest.fn(async () => {});
  actions.store = { emit: jest.fn() };
  return actions;
}

describe("Jupyter browser disk-save reconciliation", () => {
  it("does not write a partial notebook when export is canceled by teardown", async () => {
    const actions = createActions();
    const blob = deferred<Uint8Array>();
    const jupyterSaveIpynb = jest.fn();
    actions.isClosed.mockImplementation(() => actions._state === "closed");
    actions.store = {
      get_ipynb: jest.fn((refs) => {
        refs.getBase64("image");
        return { cells: [] };
      }),
    };
    actions.asyncBlobStore = { get: () => blob.promise };
    actions.syncdb = {
      get_state: () => "ready",
      fs: { jupyterSaveIpynb },
    };

    const saving = actions.saveIpynb();
    actions._state = "closed";
    actions.store = undefined;
    actions.asyncBlobStore = undefined;
    blob.resolve(new Uint8Array([65]));

    await expect(saving).resolves.toBeUndefined();
    expect(jupyterSaveIpynb).not.toHaveBeenCalled();
    expect(actions.setState).not.toHaveBeenCalled();
  });

  it("retries when kernel output advances while an older snapshot saves", async () => {
    const actions = createActions();
    const firstSave = deferred<{
      bytes: number;
      converted: boolean;
      ipynb: object;
    }>();
    const oldIpynb = { cells: [{ outputs: ["old"] }] };
    const newIpynb = { cells: [{ outputs: ["new"] }] };
    let version = "v1";
    let currentIpynb = oldIpynb;
    const jupyterSaveIpynb = jest
      .fn()
      .mockImplementationOnce(async () => await firstSave.promise)
      .mockResolvedValueOnce({
        bytes: 100,
        converted: false,
        ipynb: newIpynb,
      });
    actions.syncdb = {
      fs: { jupyterSaveIpynb },
      get_state: () => "ready",
      has_uncommitted_changes: () => false,
      newestVersion: () => version,
    };
    actions.toIpynb = jest.fn(async () => currentIpynb);
    actions.hasUnsavedChanges = true;

    const saving = actions.saveIpynb();
    await Promise.resolve();
    expect(jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(jupyterSaveIpynb).toHaveBeenLastCalledWith("race.ipynb", oldIpynb);

    // This is the archive's critical ordering: the kernel commits new output
    // before the browser receives the response for its older disk snapshot.
    version = "v2";
    currentIpynb = newIpynb;
    firstSave.resolve({
      bytes: 100,
      converted: false,
      ipynb: oldIpynb,
    });
    await saving;

    expect(jupyterSaveIpynb).toHaveBeenCalledTimes(2);
    expect(jupyterSaveIpynb).toHaveBeenLastCalledWith("race.ipynb", newIpynb);
    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.hasUnsavedChanges).toBe(false);
  });

  it("does not import a filesystem event over dirty RTC state", async () => {
    const actions = createActions();
    const saveIpynb = jest.fn(async () => {});
    const jupyterImportIpynb = jest.fn(async (ipynb) => ({ ipynb }));
    actions.syncdb = {
      fs: { jupyterImportIpynb },
      has_uncommitted_changes: () => false,
      newestVersion: () => "v2",
    };
    actions.hasUnsavedChanges = true;
    actions.saveIpynb = saveIpynb;

    await actions.watchLoadFromDisk({
      diskRead: {
        bytes: 100,
        text: "old",
        ipynb: { cells: [{ outputs: ["old"] }] },
      },
    });

    expect(saveIpynb).toHaveBeenCalledTimes(1);
    expect(jupyterImportIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("does not turn a local in-flight save event into a save loop", async () => {
    const actions = createActions();
    const savingToDisk = deferred<{
      bytes: number;
      converted: boolean;
      ipynb: object;
    }>();
    const ipynb = { cells: [{ outputs: ["current"] }] };
    const jupyterSaveIpynb = jest.fn(async () => await savingToDisk.promise);
    const jupyterImportIpynb = jest.fn(async (value) => ({ ipynb: value }));
    actions.syncdb = {
      fs: { jupyterImportIpynb, jupyterSaveIpynb },
      get_state: () => "ready",
      has_uncommitted_changes: () => false,
      newestVersion: () => "v1",
    };
    actions.toIpynb = jest.fn(async () => ipynb);
    actions.hasUnsavedChanges = true;

    const saving = actions.saveIpynb();
    await Promise.resolve();
    await actions.watchLoadFromDisk({
      diskRead: { bytes: 100, text: "current", ipynb },
    });
    savingToDisk.resolve({ bytes: 100, converted: false, ipynb });
    await saving;

    expect(jupyterSaveIpynb).toHaveBeenCalledTimes(1);
    expect(jupyterImportIpynb).not.toHaveBeenCalled();
    expect(actions.setToIpynb).not.toHaveBeenCalled();
  });

  it("abandons a disk import if RTC changes during conversion", async () => {
    const actions = createActions();
    const importing = deferred<{ ipynb: object }>();
    const diskIpynb = { cells: [{ outputs: ["old"] }] };
    const rtcIpynb = { cells: [{ outputs: ["new"] }] };
    let version = "v1";
    actions.syncdb = {
      fs: {
        jupyterImportIpynb: jest.fn(async () => await importing.promise),
      },
      has_uncommitted_changes: () => false,
      newestVersion: () => version,
    };
    actions.hasUnsavedChanges = false;
    actions.toIpynb = jest.fn(async () => rtcIpynb);
    actions.saveIpynb = jest.fn(async () => {});

    const loading = actions.watchLoadFromDisk({
      diskRead: {
        bytes: 100,
        text: "old",
        ipynb: diskIpynb,
      },
    });
    await Promise.resolve();
    version = "v2";
    actions.hasUnsavedChanges = true;
    importing.resolve({ ipynb: diskIpynb });
    await loading;

    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
  });

  it("does not treat a failed initial disk import as complete", async () => {
    const actions = createActions();
    const importError = new Error("attachment is missing");
    actions.syncdb = {
      fs: {
        jupyterImportIpynb: jest.fn(async () => {
          throw importError;
        }),
      },
    };
    actions.saveIpynb = jest.fn(async () => {});

    await expect(
      actions.watchLoadFromDisk({
        initial: true,
        diskRead: {
          bytes: 100,
          text: "notebook",
          ipynb: { cells: [{ cell_type: "markdown", source: ["content"] }] },
        },
      }),
    ).rejects.toBe(importError);

    expect(actions.setToIpynb).not.toHaveBeenCalled();
    expect(actions.saveIpynb).not.toHaveBeenCalled();
  });

  it("publishes a clean disk state after initial import commits", async () => {
    const actions = createActions();
    actions.syncdb = {
      fs: {
        jupyterImportIpynb: jest.fn(async (ipynb) => ({ ipynb })),
      },
      has_uncommitted_changes: () => false,
    };
    actions.hasUnsavedChanges = true;

    await actions.watchLoadFromDisk({
      initial: true,
      diskRead: {
        bytes: 100,
        text: "notebook",
        ipynb: { cells: [{ cell_type: "code", source: [] }] },
      },
    });

    expect(actions.hasUnsavedChanges).toBe(false);
    expect(actions.setState).toHaveBeenLastCalledWith({
      has_uncommitted_changes: false,
      has_unsaved_changes: false,
    });
    expect(actions.store.emit).toHaveBeenCalledWith(
      "has-unsaved-changes",
      false,
    );
  });

  describe("files saved by a client of the notebook", () => {
    const savedText = '{"cells": ["saved"]}';

    function openingActions({ diskMtimeMs }: { diskMtimeMs: number }) {
      const actions = createActions();
      actions.runtimeStateSettled = true;
      actions.loadFromDisk = jest.fn(async () => {});
      actions.saveIpynb = jest.fn(async () => {});
      actions.syncdb = {
        fs: { stat: jest.fn(async () => ({ mtimeMs: diskMtimeMs })) },
        get_one: () => ({ type: "cell", id: "a" }),
        has_uncommitted_changes: () => false,
        newestVersion: () => "v1",
      };
      return actions;
    }

    it("records each save, with the sha1 and mtime of the file", async () => {
      const actions = createActions();
      const ipynb = { cells: [] };
      actions.syncdb = {
        fs: {
          jupyterSaveIpynb: jest.fn(async () => ({
            bytes: 10,
            converted: false,
            ipynb,
            sha1: "abc",
            mtimeMs: 1000,
          })),
        },
        get_state: () => "ready",
        has_uncommitted_changes: () => false,
        newestVersion: () => "v1",
      };
      actions.toIpynb = jest.fn(async () => ipynb);
      await actions.saveIpynb();
      expect(actions.getIpynbSaves()).toEqual([
        expect.objectContaining({ sha1: "abc", mtimeMs: 1000 }),
      ]);
    });

    it("does not import a saved file whose mtime is newer than the live notebook", async () => {
      // The save finished writing after a newer edit reached the notebook.
      const actions = openingActions({ diskMtimeMs: 5000 });
      actions.recordIpynbSave({ sha1: sha1(savedText), mtimeMs: 5000 });
      await actions.watchLoadFromDisk({
        initial: true,
        diskRead: { bytes: savedText.length, text: savedText, ipynb: {} },
      });
      expect(actions.loadFromDisk).not.toHaveBeenCalled();
      expect(actions.saveIpynb).toHaveBeenCalledTimes(1);
    });

    it("does not import a file not modified after the newest save", async () => {
      const actions = openingActions({ diskMtimeMs: 4000 });
      actions.recordIpynbSave({ sha1: "other", mtimeMs: 5000 });
      await actions.watchLoadFromDisk({
        initial: true,
        diskRead: { bytes: savedText.length, text: savedText, ipynb: {} },
      });
      expect(actions.loadFromDisk).not.toHaveBeenCalled();
    });

    it("does not import a save recorded just after the file is read", async () => {
      // Another client wrote the file and records the save a moment later;
      // this client reads the file in between.
      const actions = openingActions({ diskMtimeMs: 6000 });
      actions.recordIpynbSave({ sha1: "older", mtimeMs: 5000 });
      setTimeout(
        () => actions.recordIpynbSave({ sha1: sha1(savedText), mtimeMs: 6000 }),
        300,
      );
      await actions.watchLoadFromDisk({
        initial: true,
        diskRead: { bytes: savedText.length, text: savedText, ipynb: {} },
      });
      expect(actions.loadFromDisk).not.toHaveBeenCalled();
    });

    it("imports an external edit of the file", async () => {
      const actions = openingActions({ diskMtimeMs: 6000 });
      actions.recordIpynbSave({ sha1: sha1(savedText), mtimeMs: 5000 });
      const edited = '{"cells": ["edited elsewhere"]}';
      await actions.watchLoadFromDisk({
        initial: true,
        diskRead: { bytes: edited.length, text: edited, ipynb: {} },
      });
      expect(actions.loadFromDisk).toHaveBeenCalledTimes(1);
      expect(actions.saveIpynb).not.toHaveBeenCalled();
    });
  });
});
