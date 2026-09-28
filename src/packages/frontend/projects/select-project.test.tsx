import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map as ImmutableMap } from "immutable";
import React from "react";

import { SelectProject } from "./select-project";

test("server project choices fetch more only near the dropdown end", () => {
  const onLoadMore = jest.fn();
  render(
    <SelectProject
      onChange={jest.fn()}
      onLoadMore={onLoadMore}
      projects={[{ id: "project", title: "Project" }]}
    />,
  );
  const list = screen.getByRole("combobox", { name: "Project" });
  Object.defineProperties(list, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(onLoadMore).not.toHaveBeenCalled();
  fireEvent.scroll(list, { target: { scrollTop: 750 } });
  expect(onLoadMore).toHaveBeenCalledTimes(1);
});

jest.mock("antd", () => {
  const actual = jest.requireActual("antd");
  const Select = ({
    children,
    onSearch,
    mode,
    value,
    disabled,
    onChange,
    style,
    ...props
  }: any) => (
    <>
      <input
        aria-label="Project search"
        onChange={(event) => onSearch(event.target.value)}
      />
      <select
        aria-label={props["aria-label"]}
        style={style}
        multiple={mode === "multiple"}
        value={value === null ? "" : value}
        disabled={disabled}
        onScroll={props.onPopupScroll}
        onChange={(event) =>
          onChange(
            mode === "multiple"
              ? Array.from(event.target.selectedOptions).map(
                  (option: any) => option.value,
                )
              : event.target.value,
          )
        }
      >
        {value === null && <option value="" hidden />}
        {children}
      </select>
    </>
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
  it("keeps a controlled picker empty when cleared to null", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <SelectProject value="owner-project" onChange={onChange} />,
    );
    const select = screen.getByRole("combobox", { name: "Project" });
    expect(select).toHaveValue("owner-project");
    rerender(<SelectProject value={null} onChange={onChange} />);
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: "collab-project" } });
    expect(onChange).toHaveBeenCalledWith("collab-project");
    expect(select).toHaveValue("");
  });

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

  it("does not allow prioritized or selected viewers to bypass full access restrictions", () => {
    render(
      <SelectProject
        multiple
        fullCollaboratorOnly
        at_top={["viewer-project"]}
        value={["viewer-project", "hidden-project"]}
        onChange={jest.fn()}
      />,
    );
    expect(screen.queryByText("Viewer Project")).toBeNull();
    expect(screen.getByText("Hidden Project")).toBeTruthy();
  });

  it("bounds results after search, allowing projects beyond the first page to be found", () => {
    render(<SelectProject maxResults={1} onChange={jest.fn()} />);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1 matches");
    fireEvent.change(screen.getByRole("textbox", { name: "Project search" }), {
      target: { value: "Collaborator" },
    });
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Collaborator Project"]);
  });

  it("uses only the server-filtered project page and rejects viewer or unknown roles", () => {
    render(
      <SelectProject
        fullCollaboratorOnly
        projects={[
          { id: "remote", title: "Remote shared", group: "collaborator" },
          { id: "viewer", title: "Remote viewer", group: "viewer" },
          { id: "unknown", title: "Unknown role" },
        ]}
        onChange={jest.fn()}
      />,
    );
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Remote shared"]);
    expect(screen.queryByRole("checkbox", { name: "Hidden" })).toBeNull();
    expect(screen.queryByText("Owner Project")).toBeNull();
  });

  it("retains multiple selected labels across hidden toggles and searches", () => {
    render(
      <SelectProject
        multiple
        value={["owner-project", "collab-project"]}
        onChange={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Hidden" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project search" }), {
      target: { value: "Hidden" },
    });
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Hidden Project", "Owner Project", "Collaborator Project"]);
  });
});
