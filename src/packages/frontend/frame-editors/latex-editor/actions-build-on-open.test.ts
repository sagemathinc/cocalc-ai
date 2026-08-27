/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Actions } from "./actions";

interface AccountOpts {
  ready?: boolean;
  buildOnSave?: boolean;
}

function makeActions({
  account,
  exists,
}: {
  account: AccountOpts | null;
  exists: boolean | Error;
}) {
  const fakeAccount =
    account == null
      ? undefined
      : {
          waitUntilReady: jest.fn(async () => account.ready ?? true),
          getIn: jest.fn((path: string[]) =>
            path[1] === "build_on_save"
              ? (account.buildOnSave ?? true)
              : undefined,
          ),
        };
  const exists_fn = jest.fn(async () => {
    if (exists instanceof Error) throw exists;
    return exists;
  });
  const actions: any = Object.create(Actions.prototype);
  actions.project_id = "project-1";
  actions.path = "docs/paper.tex";
  actions._state = "ready";
  actions.redux = { getStore: () => fakeAccount };
  actions.fs = () => ({ exists: exists_fn });
  return { actions, fakeAccount, exists_fn };
}

async function shouldBuildOnOpen(actions: any): Promise<boolean> {
  return await (Actions.prototype as any).shouldBuildOnOpen.call(actions);
}

describe("LaTeX build-on-open decision", () => {
  it("builds when settings are loaded, build_on_save is on, and no pdf exists", async () => {
    const { actions, exists_fn } = makeActions({
      account: { ready: true, buildOnSave: true },
      exists: false,
    });
    expect(await shouldBuildOnOpen(actions)).toBe(true);
    expect(exists_fn).toHaveBeenCalledWith("docs/paper.pdf");
  });

  it("does not build when the pdf already exists", async () => {
    const { actions } = makeActions({
      account: { ready: true, buildOnSave: true },
      exists: true,
    });
    expect(await shouldBuildOnOpen(actions)).toBe(false);
  });

  it("does not build when build_on_save is disabled", async () => {
    const { actions, exists_fn } = makeActions({
      account: { ready: true, buildOnSave: false },
      exists: false,
    });
    expect(await shouldBuildOnOpen(actions)).toBe(false);
    // we should not even bother looking at the filesystem
    expect(exists_fn).not.toHaveBeenCalled();
  });

  it("does not build when waiting for account settings times out", async () => {
    const { actions, exists_fn } = makeActions({
      account: { ready: false, buildOnSave: true },
      exists: false,
    });
    expect(await shouldBuildOnOpen(actions)).toBe(false);
    expect(exists_fn).not.toHaveBeenCalled();
  });

  it("does not build when the filesystem check fails (unknown != missing)", async () => {
    const { actions } = makeActions({
      account: { ready: true, buildOnSave: true },
      exists: new Error("project not running"),
    });
    expect(await shouldBuildOnOpen(actions)).toBe(false);
  });

  it("does not build when the editor was closed while waiting", async () => {
    const { actions } = makeActions({
      account: { ready: true, buildOnSave: true },
      exists: false,
    });
    actions.redux = {
      getStore: () => ({
        waitUntilReady: async () => {
          actions._state = "closed";
          return true;
        },
        getIn: () => true,
      }),
    };
    expect(await shouldBuildOnOpen(actions)).toBe(false);
  });
});
