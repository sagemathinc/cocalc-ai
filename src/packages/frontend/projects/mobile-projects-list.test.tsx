/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render } from "@testing-library/react";
import { MobileProjectsList } from "./mobile-projects-list";

// An instructor of a large course can have thousands of projects; the narrow
// layout must virtualize them like the collection does.
const mockRecords = Array.from({ length: 1000 }, (_, i) => ({
  project_id: `p${i}`,
  title: `Project ${i}`,
  description: "",
  starred: false,
  hidden: false,
  collaborators: [],
  currentRole: "owner" as const,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({ open_project: jest.fn() }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  ProjectState: () => null,
  TimeAgo: () => null,
}));
jest.mock("@cocalc/frontend/i18n", () => ({
  labels: { project: { defaultMessage: "Project" } },
}));
jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  useIntl: () => ({ formatMessage: (m) => m.defaultMessage }),
}));
jest.mock("./collaborators-avatars", () => ({
  CollaboratorsAvatars: () => null,
}));
jest.mock("./project-rootfs-badge", () => ({
  ProjectRootfsBadge: () => null,
  ProjectRootfsRuntimeModal: () => null,
}));
jest.mock("./projects-actions-menu", () => ({
  ProjectActionsMenu: () => null,
}));
jest.mock("./theme", () => ({ ProjectThemeAvatar: () => null }));
jest.mock("./projects-table-columns", () => ({
  projectDescriptionText: (d) => d ?? "",
}));
jest.mock("./use-project-table-records", () => ({
  useProjectTableRecords: () => mockRecords,
}));
jest.mock("./use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    isProjectBookmarked: () => false,
    setProjectBookmarked: jest.fn(),
  }),
}));

function cards(scrollParent?: HTMLElement | null) {
  const { container } = render(
    <MobileProjectsList
      visible_projects={mockRecords.map((r) => r.project_id)}
      rootfsImages={[]}
      selectedProjectIds={[]}
      onSelectedProjectIdsChange={jest.fn()}
      scrollParent={scrollParent}
    />,
  );
  return container.querySelectorAll("[data-cocalc-mobile-project-card]").length;
}

it("renders nothing until the scroll container mounts", () => {
  expect(cards(null)).toBe(0);
});

it("renders only a window of the cards in the scroll container", () => {
  const scrollParent = document.createElement("div");
  document.body.appendChild(scrollParent);
  expect(cards(scrollParent)).toBeLessThan(100);
  scrollParent.remove();
});

it("without a scroll container, renders every card", () => {
  expect(cards(undefined)).toBe(1000);
});
