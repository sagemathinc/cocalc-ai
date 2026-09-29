/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceCollectionPanels } from "./workspace-collection-panels";

jest.mock("@cocalc/frontend/collaborators/page", () => ({
  CollaboratorsPage: ({ active }) => (
    <section aria-label="People" hidden={!active}>
      <h1>People</h1>
      <input aria-label="Filter conversations" />
    </section>
  ),
}));
jest.mock("./artifact-browser", () => ({
  AgentArtifactBrowser: ({ active }) => (
    <section aria-label="Artifacts" hidden={!active}>
      <input aria-label="Filter artifacts" />
    </section>
  ),
}));

const props = {
  accountId: "account-a",
  blocked: false,
  status: false,
  collaboratorsEnabled: true,
  collaboratorsOpen: true,
  collaborators: { active: true, onNavigate: jest.fn() },
  artifacts: { active: false, agents: [], onSelect: jest.fn() },
};

it("keeps exactly one People panel through background updates and keyboard navigation", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<WorkspaceCollectionPanels {...props} />);
  const filter = screen.getByRole("textbox", { name: "Filter conversations" });
  await user.tab();
  expect(filter).toHaveFocus();
  await user.keyboard("recent conversation");

  for (let i = 0; i < 5; i++) {
    rerender(<WorkspaceCollectionPanels {...props} />);
    expect(screen.getAllByRole("heading", { name: "People" })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Filter conversations" })).toBe(
      filter,
    );
    expect(filter).toHaveFocus();
    expect(filter).toHaveValue("recent conversation");
  }

  rerender(
    <WorkspaceCollectionPanels
      {...props}
      collaboratorsOpen={false}
      collaborators={{ ...props.collaborators, active: false }}
      artifacts={{ ...props.artifacts, active: true }}
    />,
  );
  expect(screen.queryByRole("heading", { name: "People" })).toBeNull();
  const artifactFilter = screen.getByRole("textbox", {
    name: "Filter artifacts",
  });
  await user.tab();
  expect(artifactFilter).toHaveFocus();
  await user.keyboard("report");
  rerender(<WorkspaceCollectionPanels {...props} />);
  expect(screen.getByRole("textbox", { name: "Filter conversations" })).toBe(
    filter,
  );
  expect(artifactFilter).toHaveValue("report");
});

it("does not leave orphaned People panels during URL resolution or account changes", () => {
  const { rerender } = render(<WorkspaceCollectionPanels {...props} />);
  for (let i = 0; i < 3; i++) {
    rerender(
      <WorkspaceCollectionPanels
        {...props}
        blocked
        status={<p role="status">Resolving link</p>}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "People", hidden: true }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Resolving link");
    rerender(<WorkspaceCollectionPanels {...props} />);
    expect(screen.getAllByRole("heading", { name: "People" })).toHaveLength(1);
  }
  const previousFilter = screen.getByRole("textbox", {
    name: "Filter conversations",
  });
  rerender(<WorkspaceCollectionPanels {...props} accountId="account-b" />);
  expect(previousFilter).not.toBeInTheDocument();
  expect(screen.getAllByRole("heading", { name: "People" })).toHaveLength(1);
  rerender(<WorkspaceCollectionPanels {...props} accountId={undefined} />);
  expect(
    screen.queryByRole("region", { name: "People", hidden: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Artifacts", hidden: true }),
  ).toBeNull();
});

it("does not retain People DOM when the feature is disabled", () => {
  const { rerender } = render(<WorkspaceCollectionPanels {...props} />);
  rerender(
    <WorkspaceCollectionPanels {...props} collaboratorsEnabled={false} />,
  );
  expect(
    screen.queryByRole("heading", { name: "People", hidden: true }),
  ).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "not enabled on this site",
  );
});
