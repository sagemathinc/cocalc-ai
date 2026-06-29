import { render, screen } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";
import React from "react";

import { SelectProject } from "./select-project";

jest.mock("antd", () => {
  const actual = jest.requireActual("antd");
  const Select = ({ children }: { children: React.ReactNode }) => (
    <select>{children}</select>
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
  it("can limit choices to full collaborator projects", () => {
    render(<SelectProject fullCollaboratorOnly onChange={jest.fn()} />);

    expect(screen.getByText("Owner Project")).toBeTruthy();
    expect(screen.getByText("Collaborator Project")).toBeTruthy();
    expect(screen.queryByText("Viewer Project")).toBeNull();
  });
});
