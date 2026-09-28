import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import React from "react";
import { DirectoryPicker } from "./directory-picker";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useState: React.useState,
  useMemo: React.useMemo,
  useTypedRedux: () => fromJS({}),
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { account_id: "me" },
}));
jest.mock("@cocalc/frontend/components", () => ({ Loading: () => null }));

const page = (items: any[], next?: string) => ({
  items,
  next,
  coverage: "complete",
});
const project = {
  project_id: "shared",
  title: "Shared project",
  role: "collaborator",
};

it("reuses the project selector with bounded, shared-only, person-filtered queries", async () => {
  const user = userEvent.setup();
  const api = {
    listProjects: jest.fn().mockResolvedValue(page([project], "next")),
  };
  const select = jest.fn();
  render(
    <DirectoryPicker
      api={api as any}
      kind="project"
      title="Choose project"
      sharedOnly
      personId="person"
      onSelect={select}
      onClose={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(api.listProjects).toHaveBeenCalledWith({
      search: "",
      person_id: "person",
      shared_only: true,
      after: undefined,
      limit: 25,
    }),
  );
  const selector = screen.getByRole("combobox", { name: "Search projects" });
  await user.click(selector);
  fireEvent.keyDown(selector, { key: "Enter", keyCode: 13, which: 13 });
  expect(select).toHaveBeenCalledWith({
    id: "shared",
    title: "Shared project",
  });
  await user.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "next", shared_only: true, limit: 25 }),
    ),
  );
});

it("keeps search mounted and focused after zero results and allows another search", async () => {
  const user = userEvent.setup();
  const api = {
    listProjects: jest.fn(async ({ search }) =>
      page(search === "none" ? [] : [project]),
    ),
  };
  render(
    <DirectoryPicker
      api={api as any}
      kind="project"
      title="Choose project"
      onSelect={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  const selector = screen.getByRole("combobox", { name: "Search projects" });
  await user.type(selector, "none");
  await screen.findByText("No matches. Try another search or clear a filter.");
  expect(selector).toHaveFocus();
  await user.clear(selector);
  await user.type(selector, "Shared");
  await waitFor(() =>
    expect(api.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "Shared", limit: 25 }),
    ),
  );
  expect(selector).toHaveFocus();
});
