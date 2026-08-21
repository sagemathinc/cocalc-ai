/*
 *  This file is part of CoCalc: Copyright © 2026, Sagemath Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc/blob/master/LICENSE.md
 */

const mockOpenProject = jest.fn(async () => {});
const mockOpenFile = jest.fn(async () => {});
const mockEditorActions = {};

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(() => ({ open_project: mockOpenProject })),
    getProjectActions: jest.fn(() => ({ open_file: mockOpenFile })),
    getEditorActions: jest.fn(() => mockEditorActions),
  },
}));

import {
  getEditorActionsForPath,
  openFileInProject,
} from "./project-open-helpers";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

describe("project open helpers", () => {
  beforeEach(() => {
    mockOpenProject.mockClear();
    mockOpenFile.mockClear();
  });

  it("keeps ordinary background opens lazy", async () => {
    await openFileInProject({
      project_id: PROJECT_ID,
      path: "/root/paper.tex",
      foreground: false,
      foreground_project: false,
    });

    expect(mockOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ wait_for_ready: false }),
    );
  });

  it("can hydrate a background editor before returning its actions", async () => {
    const actions = await getEditorActionsForPath({
      project_id: PROJECT_ID,
      path: "/root/paper.tex",
      foreground: false,
      foreground_project: false,
      wait_for_ready: true,
    });

    expect(actions).toBe(mockEditorActions);
    expect(mockOpenFile).toHaveBeenCalledWith({
      path: "/root/paper.tex",
      foreground: false,
      foreground_project: false,
      wait_for_ready: true,
    });
  });
});
