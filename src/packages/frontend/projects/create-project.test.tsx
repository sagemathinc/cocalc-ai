/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { NewProjectCreator } from "./create-project";

const listHosts = jest.fn();
const applyPreset = jest.fn();
let mockTitle = "";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { hosts: { listHosts: (...a) => listHosts(...a) } },
    },
  },
}));
jest.mock("@cocalc/frontend/project/runtime-capabilities", () => ({
  useProjectRuntimeCapabilities: () => ({
    rootfs: true,
    host_placement: true,
    gpu: true,
    backups: true,
    label: "Project host",
  }),
}));
jest.mock("@cocalc/frontend/hosts/select-new-host", () => ({
  SelectNewHost: () => <div>Host picker</div>,
}));
jest.mock("./create/project-create-health-card", () => ({
  ProjectCreateHealthCard: () => null,
}));
jest.mock("@cocalc/frontend/rootfs/catalog-picker", () => ({
  RootfsCatalogPicker: ({ images }) => (
    <ul aria-label="Images">
      {images.map((image) => (
        <li key={image.id}>{image.label}</li>
      ))}
    </ul>
  ),
}));
const standard = {
  id: "standard",
  image: "cocalc.local/rootfs/standard",
  label: "standard",
  official: true,
  release_id: "r1",
};
const x11 = {
  id: "x11",
  image: "cocalc.local/rootfs/x11",
  label: "X11",
  release_id: "r2",
};
jest.mock("./create/use-project-create-draft", () => ({
  useProjectCreateDraft: () => ({
    draft: {
      title: mockTitle,
      mode: "standard",
      region: "wnam",
      rootfs_image: "cocalc.local/rootfs/standard",
      rootfs_image_id: "standard",
      rootfs_reason: { kind: "recent", project_id: "p1", title: "Thesis" },
    },
    summary: {
      rootfs_image: "cocalc.local/rootfs/standard",
      rootfsLabel: "standard",
      region: "wnam",
      gpu: false,
      warnings: mockTitle ? [] : ["Project title is required."],
    },
    rootfsImages: [x11, standard],
    rootfsLoading: false,
    isAdmin: false,
    setTitle: jest.fn(),
    setHost: jest.fn(),
    setRootfs: jest.fn(),
    applyPreset: (...a) => applyPreset(...a),
    reset: jest.fn(),
  }),
}));

function renderCreator() {
  return render(
    <IntlProvider locale="en">
      <NewProjectCreator default_value="" open onClose={jest.fn()} />
    </IntlProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTitle = "";
  listHosts.mockResolvedValue([]);
});

it("is one column: name, image with why, where it runs, and the create buttons", async () => {
  renderCreator();
  expect(
    screen.getByText('standard (as in your project "Thesis")'),
  ).toBeInTheDocument();
  // No presets, no summary card, no premature title warning.
  expect(screen.queryByText("Teaching")).toBeNull();
  expect(screen.queryByText("Project summary")).toBeNull();
  expect(screen.queryByText("Project title is required.")).toBeNull();
  // Every CPU image is listed, official first.
  expect(
    screen
      .getByRole("list", { name: "Images" })
      .textContent?.replace(/\s+/g, ""),
  ).toBe("standardX11");
  expect(screen.getByText("Host picker")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Create and open/ }),
  ).toBeDisabled();
  await waitFor(() => expect(listHosts).toHaveBeenCalled());
  expect(screen.queryByRole("checkbox", { name: "Use a GPU" })).toBeNull();
});

it("offers a GPU only when a GPU host is available to you", async () => {
  listHosts.mockResolvedValue([{ id: "h1", gpu: true }]);
  const user = userEvent.setup();
  renderCreator();
  const gpu = await screen.findByRole("checkbox", { name: "Use a GPU" });
  await user.click(gpu);
  expect(applyPreset).toHaveBeenCalledWith("gpu");
});
