/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickProjectCreator } from "./quick-project-creator";

const createProject = jest.fn(async () => "new-project-id");
const openProject = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      create_project: (...a) => createProject(...a),
      open_project: (...a) => openProject(...a),
    }),
  },
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/project/runtime-capabilities", () => ({
  useProjectRuntimeCapabilities: () => ({ rootfs: true, host_placement: true }),
}));
jest.mock("./create/use-project-create-draft", () => ({
  useProjectCreateDraft: () => ({
    draft: { title: "", rootfs_image: "img", mode: "standard", region: "wnam" },
    summary: {
      rootfs_image: "img",
      rootfsLabel: "standard 1.2",
      region: "wnam",
      warnings: [],
    },
    rootfsLoading: false,
  }),
}));
jest.mock("./create/project-create-draft", () => ({
  projectDraftToCreateOptions: (draft) => ({
    title: draft.title,
    start: draft.start,
    rootfs_image: draft.rootfs_image,
  }),
}));

beforeEach(() => jest.clearAllMocks());

it("names the project, shows the defaults, creates and opens it", async () => {
  const user = userEvent.setup();
  const onClose = jest.fn();
  render(
    <QuickProjectCreator open onClose={onClose} onMoreOptions={jest.fn()} />,
  );
  expect(
    screen.getByText(/standard 1\.2 · automatic host · backups in/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Create and open/ }),
  ).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "Thesis",
  );
  await user.click(screen.getByRole("button", { name: /Create and open/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(createProject).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Thesis", start: true }),
  );
  expect(openProject).toHaveBeenCalledWith({
    project_id: "new-project-id",
    target: "files/",
    switch_to: true,
  });
});

it("More options carries the typed name to the full creator", async () => {
  const user = userEvent.setup();
  const onMoreOptions = jest.fn();
  render(
    <QuickProjectCreator
      open
      onClose={jest.fn()}
      onMoreOptions={onMoreOptions}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "GPU work",
  );
  await user.click(screen.getByRole("button", { name: "More options…" }));
  expect(onMoreOptions).toHaveBeenCalledWith("GPU work");
  expect(createProject).not.toHaveBeenCalled();
});

it("shows a creation error and stays open", async () => {
  createProject.mockRejectedValueOnce(new Error("Project limit reached"));
  const user = userEvent.setup();
  const onClose = jest.fn();
  render(
    <QuickProjectCreator open onClose={onClose} onMoreOptions={jest.fn()} />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "X{Enter}",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Project limit reached",
  );
  expect(onClose).not.toHaveBeenCalled();
});
