import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map as ImmutableMap } from "immutable";
import React from "react";

import { SelectProject } from "./select-project";

jest.mock("antd", () => {
  const actual = jest.requireActual("antd");
  const Select = ({
    children,
    style,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    style?: React.CSSProperties;
    "aria-label"?: string;
  }) => (
    <select style={style} aria-label={ariaLabel}>
      {children}
    </select>
  );
  Select.Option = ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>;
  return { ...actual, Select };
});

const projectMap = ImmutableMap({
  "owner-project": ImmutableMap({
    project_id: "owner-project",
    title: "Owner Project",
    last_edited: "2026-01-03",
    users: ImmutableMap({
      "account-1": ImmutableMap({ group: "owner" }),
    }),
  }),
  "collab-project": ImmutableMap({
    project_id: "collab-project",
    title: "Collaborator Project",
    last_edited: "2026-01-02",
    users: ImmutableMap({
      "account-1": ImmutableMap({ group: "collaborator" }),
    }),
  }),
  "viewer-project": ImmutableMap({
    project_id: "viewer-project",
    title: "Viewer Project",
    last_edited: "2026-01-01",
    users: ImmutableMap({
      "account-1": ImmutableMap({ group: "viewer" }),
    }),
  }),
  "hidden-project": ImmutableMap({
    project_id: "hidden-project",
    title: "Hidden Project",
    last_edited: "2026-01-04",
    users: ImmutableMap({
      "account-1": ImmutableMap({ group: "owner", hide: true }),
    }),
  }),
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useMemo: React.useMemo,
  useState: React.useState,
  useTypedRedux: (store: string, key: string) => {
    if (store === "projects" && key === "project_map") {
      return projectMap;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { account_id: "account-1" },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading</div>,
}));

describe("SelectProject", () => {
  it("allows the selector to shrink beside the keyboard-operable hidden-project control", async () => {
    render(<SelectProject ariaLabel="Project" onChange={jest.fn()} />);
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveStyle({
      minWidth: "0",
    });
    const hidden = screen.getByRole("checkbox", { name: "Hidden" });
    hidden.focus();
    await userEvent.keyboard(" ");
    expect(hidden).toBeChecked();
    expect(hidden).toHaveFocus();
    expect(screen.getByText("Hidden Project")).toBeInTheDocument();
  });
  it("can limit choices to full collaborator projects", () => {
    render(<SelectProject fullCollaboratorOnly onChange={jest.fn()} />);

    expect(screen.getByText("Owner Project")).toBeTruthy();
    expect(screen.getByText("Collaborator Project")).toBeTruthy();
    expect(screen.queryByText("Viewer Project")).toBeNull();
  });

  it("sorts visible projects by recent use and hides hidden projects", () => {
    render(<SelectProject onChange={jest.fn()} />);

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Owner Project",
      "Collaborator Project",
      "Viewer Project",
    ]);
    expect(screen.queryByText("Hidden Project")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Hidden" }));
    expect(screen.getByText("Hidden Project")).toBeTruthy();
    expect(screen.queryByText("Owner Project")).toBeNull();
  });

  it("offers only projects the filter accepts, still sorted by recent use", () => {
    render(
      <SelectProject
        filter={(project) => project.project_id !== "collab-project"}
        onChange={jest.fn()}
      />,
    );
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Owner Project", "Viewer Project"]);
  });
});
