/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { JupyterActions } from "./actions";

it.each(["getBase64", "getString"] as const)(
  "cancels export when the notebook closes while resolving %s output",
  async (getter) => {
    const actions = new JupyterActions("export-lifecycle-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    let resolveBlob!: (value: Uint8Array) => void;
    const blob = new Promise<Uint8Array>((resolve) => (resolveBlob = resolve));
    const getBlob = jest.fn(() => blob);
    const getIpynb = jest.fn((refs) => {
      refs[getter]("first");
      refs[getter]("second");
      return { cells: [] };
    });
    Object.assign(actions, {
      _state: "ready",
      store: { get_ipynb: getIpynb, destroy: jest.fn() },
      asyncBlobStore: { get: getBlob },
    });

    const exporting = actions.toIpynb();
    expect(getBlob).toHaveBeenCalledWith("first");
    actions.close();
    expect(actions.isClosed()).toBe(true);
    expect(actions.store).toBeUndefined();
    expect(actions.asyncBlobStore).toBeUndefined();
    resolveBlob(new Uint8Array([65]));

    await expect(exporting).resolves.toBeUndefined();
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getIpynb).toHaveBeenCalledTimes(1);
  },
);

it("ignores an export requested after notebook teardown", async () => {
  const actions = new JupyterActions("closed-export-test", {} as any);
  await expect(actions.toIpynb()).resolves.toBeUndefined();
});

it("cancels export when a pending blob read rejects after teardown", async () => {
  const actions = new JupyterActions("rejected-export-test", {} as any);
  let rejectBlob!: (err: Error) => void;
  const blob = new Promise<Uint8Array>((_, reject) => (rejectBlob = reject));
  const getIpynb = jest.fn((refs) => {
    refs.getBase64("image");
    return { cells: [] };
  });
  Object.assign(actions, {
    _state: "ready",
    store: { get_ipynb: getIpynb },
    asyncBlobStore: { get: () => blob },
  });
  const exporting = actions.toIpynb();
  Object.assign(actions, { _state: "closed", store: undefined });
  rejectBlob(new Error("Closed blob store"));
  await expect(exporting).resolves.toBeUndefined();
  expect(getIpynb).toHaveBeenCalledTimes(1);
});

it("resolves both text and image blobs while the notebook remains open", async () => {
  const actions = new JupyterActions("ready-export-test", {} as any);
  const getIpynb = jest.fn((refs) => ({
    image: refs.getBase64("image"),
    text: refs.getString("text"),
  }));
  Object.assign(actions, {
    _state: "ready",
    store: { get_ipynb: getIpynb },
    asyncBlobStore: { get: jest.fn(async () => new Uint8Array([65])) },
  });
  await expect(actions.toIpynb()).resolves.toEqual({
    image: "QQ==",
    text: "A",
  });
  expect(getIpynb).toHaveBeenCalledTimes(2);
});
