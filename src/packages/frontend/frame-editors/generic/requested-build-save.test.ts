/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildRequestJobKey } from "@cocalc/util/document-build";
import type { ExecuteCodeOutputAsync } from "@cocalc/util/types/execute-code";

import { Actions as LatexActions } from "../latex-editor/actions";
import { Actions as QmdActions } from "../qmd-editor/actions";
import { Actions as RmdActions } from "../rmd-editor/actions";

function requestedBuild(path: string): ExecuteCodeOutputAsync {
  return {
    aggregate: 42,
    job_key: buildRequestJobKey({ request_id: "request-1", path }),
    status: "running",
    type: "async",
  } as ExecuteCodeOutputAsync;
}

function stageBuild(): ExecuteCodeOutputAsync {
  return {
    aggregate: 42,
    status: "running",
    type: "async",
  } as ExecuteCodeOutputAsync;
}

function baseFixture(actions: any, path: string): any {
  actions.path = path;
  actions.project_id = "project-1";
  actions.is_building = false;
  actions.store = { get: jest.fn(() => undefined) };
  return actions;
}

describe("requested document builds save live editor state", () => {
  it("saves all LaTeX sources before running the requested pipeline", async () => {
    const actions: any = baseFixture(
      Object.create(LatexActions.prototype),
      "/home/user/paper.tex",
    );
    const order: string[] = [];
    actions.knitr = false;
    actions.is_stopping = false;
    actions.save_all = jest.fn(async () => order.push("save"));
    actions.run_build = jest.fn(async () => order.push("build"));
    actions.last_save_time = jest.fn(() => 1);

    await actions.follow_project_build(requestedBuild(actions.path));

    expect(order).toEqual(["save", "build"]);
    expect(actions.save_all).toHaveBeenCalledWith(false);
    expect(actions.run_build).toHaveBeenCalledWith(42, false);
  });

  it("does not save again when passively following a LaTeX stage", async () => {
    const actions: any = baseFixture(
      Object.create(LatexActions.prototype),
      "/home/user/paper.tex",
    );
    actions.knitr = false;
    actions.is_stopping = false;
    actions.save_all = jest.fn(async () => undefined);
    actions.run_build = jest.fn(async () => undefined);

    await actions.follow_project_build(stageBuild());

    expect(actions.save_all).not.toHaveBeenCalled();
    expect(actions.run_build).toHaveBeenCalledWith(42, false);
  });

  for (const { name, Actions, extension, converter } of [
    {
      name: "R Markdown",
      Actions: RmdActions,
      extension: "Rmd",
      converter: "_run_rmd_converter",
    },
    {
      name: "Quarto",
      Actions: QmdActions,
      extension: "qmd",
      converter: "_run_qmd_converter",
    },
  ] as const) {
    it(`saves ${name} before running the requested converter`, async () => {
      const actions: any = baseFixture(
        Object.create(Actions.prototype),
        `/home/user/paper.${extension}`,
      );
      const order: string[] = [];
      actions.save = jest.fn(async () => order.push("save"));
      actions[converter] = jest.fn(async () => order.push("build"));

      await actions.follow_project_build(requestedBuild(actions.path));

      expect(order).toEqual(["save", "build"]);
      expect(actions.save).toHaveBeenCalledWith(false);
      expect(actions[converter]).toHaveBeenCalledWith(42);
    });

    it(`does not save again when passively following a ${name} stage`, async () => {
      const actions: any = baseFixture(
        Object.create(Actions.prototype),
        `/home/user/paper.${extension}`,
      );
      actions.save = jest.fn(async () => undefined);
      actions[converter] = jest.fn(async () => undefined);

      await actions.follow_project_build(stageBuild());

      expect(actions.save).not.toHaveBeenCalled();
      expect(actions[converter]).toHaveBeenCalledWith(42);
    });
  }
});
