/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
const setRootfs = jest.fn();
let mockDraft: any;
const officialImage = (id: string, tags: string[]) => ({
  id,
  image: `cocalc.local/rootfs/${id}`,
  label: `${id} image`,
  official: true,
  release_id: `release-${id}`,
  tags,
});
let mockImages: any[] = [];
jest.mock("./create/use-project-create-draft", () => ({
  useProjectCreateDraft: () => ({
    draft: mockDraft.draft,
    summary: mockDraft.summary,
    rootfsLoading: false,
    rootfsImages: mockImages,
    isAdmin: false,
    setRootfs: (...a) => setRootfs(...a),
  }),
}));
function useDraft({
  image = "img",
  image_id,
  label = "standard 1.2",
  reason,
  warnings = [],
}: {
  image?: string;
  image_id?: string;
  label?: string;
  reason?: any;
  warnings?: string[];
} = {}) {
  mockDraft = {
    draft: {
      title: "",
      rootfs_image: image,
      rootfs_image_id: image_id,
      rootfs_reason: reason,
      mode: "standard",
      region: "wnam",
    },
    summary: {
      rootfs_image: image,
      rootfsLabel: label,
      rootfsReason: reason,
      region: "wnam",
      warnings,
    },
  };
}
jest.mock("./create/project-create-draft", () => ({
  projectDraftToCreateOptions: (draft) => ({
    title: draft.title,
    start: draft.start,
    rootfs_image: draft.rootfs_image,
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockImages = [];
  useDraft();
});

it("says why the image was chosen, and offers the site's few images in one click", async () => {
  mockImages = [
    officialImage("python", ["onboarding:jupyter-python"]),
    officialImage("r", ["onboarding:jupyter-r"]),
    officialImage("sage", ["onboarding:sage"]),
  ];
  useDraft({
    image: "cocalc.local/rootfs/sage",
    image_id: "sage",
    label: "SageMath 10",
    reason: { kind: "recent", project_id: "p1", title: "Thesis" },
    // The empty name is asked for in place, not as a warning.
    warnings: ["Project title is required."],
  });
  const user = userEvent.setup();
  render(
    <QuickProjectCreator open onClose={jest.fn()} onMoreOptions={jest.fn()} />,
  );
  expect(
    screen.getByText(/SageMath 10 \(as in your project "Thesis"\)/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Project title is required.")).toBeNull();
  const group = screen.getByRole("group", { name: "Image" });
  expect(
    within(group)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["Python", "R", "SageMath"]);
  expect(
    within(group).getByRole("button", { name: "SageMath" }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(within(group).getByRole("button", { name: "R" }));
  expect(setRootfs).toHaveBeenCalledWith({
    image: "cocalc.local/rootfs/r",
    image_id: "r",
  });
});

it("asks for an image when nothing says which one", async () => {
  mockImages = [
    officialImage("python", ["onboarding:jupyter-python"]),
    officialImage("r", ["onboarding:jupyter-r"]),
  ];
  useDraft({
    image: "",
    label: "No image selected",
    warnings: ["Choose an image."],
  });
  const user = userEvent.setup();
  render(
    <QuickProjectCreator
      open
      defaultTitle="Thesis"
      onClose={jest.fn()}
      onMoreOptions={jest.fn()}
    />,
  );
  expect(screen.getByText(/Choose an image above/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Create and open/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose an image for the project.",
  );
  expect(createProject).not.toHaveBeenCalled();
});

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
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(createProject).toHaveBeenCalledTimes(2);
});

it.each(["Enter", "click"])(
  "shares a synchronous in-flight guard for %s followed by repeated Enter and click",
  async (first) => {
    let resolve!: (id: string) => void;
    createProject.mockReturnValueOnce(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(
      <QuickProjectCreator
        open
        defaultTitle="Thesis"
        onClose={onClose}
        onMoreOptions={jest.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Project name" });
    const button = screen.getByRole("button", { name: /Create and open/ });
    await waitFor(() => expect(input).toHaveFocus());
    // Both events run before React can paint the loading/disabled button.
    act(() => {
      if (first === "Enter")
        fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
      else fireEvent.click(button);
      fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
    });
    input.focus();
    await user.keyboard("{Enter}{Enter}");
    expect(input).toHaveFocus();
    await user.click(button);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    await act(async () => resolve("new-project-id"));
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  },
);
