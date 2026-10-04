/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibrarySidebar } from "./library-sidebar";

const setPinned = jest.fn();
const hit = (id: string, title: string) => ({
  catalogEntryId: id,
  agent: { name: "helper", endpoint: { project_id: "p", agent_id: "a" } },
  threadId: "t",
  historical: false,
  hit: { artifact_title: title, artifact_kind: "file" },
});
const mockHits = [hit("e1", "Report"), hit("e2", "Plot"), hit("e3", "Notes")];

let mockRoute: { project?: string; entry?: string } = {
  project: "p",
  entry: "e2",
};
let mockNames: any[] = [];
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, field: string) =>
    field === "library_project_id"
      ? mockRoute.project
      : field === "library_entry_id"
        ? mockRoute.entry
        : undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  isIconName: () => false,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({ pins: ["e3"], setPinned, move: jest.fn() }),
}));
jest.mock("./artifact-names", () => ({
  useArtifactNames: () => ({ names: mockNames }),
}));
const mockState = { entries: [], loading: false };
jest.mock("./artifact-catalog-store", () => ({
  sharedArtifactCatalog: () => ({
    subscribe: () => () => {},
    get: () => mockState,
  }),
  catalogResults: () => mockHits,
  artifactIdentity: (h) => h.catalogEntryId,
}));

it("pinned and recent artifacts; the open one is current", async () => {
  const onOpen = jest.fn();
  const user = userEvent.setup();
  render(
    <LibrarySidebar
      search=""
      accountId="acct"
      agents={[]}
      onOpen={onOpen}
      onAll={jest.fn()}
    />,
  );
  expect(
    within(screen.getByRole("list", { name: "Pinned artifacts" })).getByRole(
      "button",
      { name: "Open artifact Notes" },
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open artifact Plot" }),
  ).toHaveAttribute("aria-current", "page");
  await user.click(
    screen.getByRole("button", { name: "Open artifact Report" }),
  );
  expect(onOpen).toHaveBeenCalledWith(mockHits[0]);
  await user.click(screen.getByRole("button", { name: "Pin Report" }));
  expect(setPinned).toHaveBeenCalledWith("e1", true);
});

it("an artifact opened by its name is current too, even with the section collapsed", () => {
  mockRoute = { project: "plan" };
  mockNames = [{ name: "plan", project_id: "p", entry_id: "e1", active: true }];
  render(
    <LibrarySidebar
      inSection
      onlyCurrent
      search=""
      accountId="acct"
      agents={[]}
      onOpen={jest.fn()}
      onAll={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Open artifact Report" }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.queryByRole("button", { name: "Open artifact Plot" }),
  ).toBeNull();
  mockRoute = { project: "p", entry: "e2" };
  mockNames = [];
});
