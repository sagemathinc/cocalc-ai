import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type {
  InvitationProject,
  InvitationProjectChoice,
} from "./invitation-api";
import { defaultProjectChoice } from "./invitation-choices";
import { InvitationProjectsTable } from "./invitation-projects-table";

const project: InvitationProject = {
  project_id: "project",
  title: "Research",
  current_access: "none",
  content_access: "unknown",
  can_invite: true,
  can_notify: false,
};

test("groups shared projects first and only warns about the intended content's project", () => {
  render(
    <InvitationProjectsTable
      rows={[
        project,
        { ...project, project_id: "other", title: "Other research" },
        {
          ...project,
          project_id: "shared",
          title: "Shared research",
          current_access: "collaborator",
          can_notify: true,
          content_access: "allowed",
        },
      ]}
      knownRows={{}}
      choices={[]}
      disabled={false}
      targetProjectId="project"
      onChange={jest.fn()}
    />,
  );
  expect(screen.getAllByRole("checkbox")[0]).toHaveAccessibleName(
    "Select Shared research",
  );
  expect(screen.getByText("Already shared")).toBeVisible();
  expect(
    screen.getAllByText("Content access has not been established."),
  ).toHaveLength(1);
  expect(
    screen.getByRole("region", { name: "Project choices" }),
  ).toHaveAttribute("tabindex", "0");
});

test("a viewer is never upgraded by the default choice", () => {
  expect(
    defaultProjectChoice({
      ...project,
      current_access: "viewer",
      can_notify: false,
      content_access: "denied",
    }),
  ).toBeUndefined();
  expect(
    defaultProjectChoice({
      ...project,
      current_access: "viewer",
      can_notify: true,
      content_access: "allowed",
    }),
  ).toEqual({ project_id: "project", action: "notify" });
});

test("pending offers retain the proposed role and exact read policy", () => {
  const policy = { rules: [{ action: "include" as const, path: "public/**" }] };
  expect(
    defaultProjectChoice({
      ...project,
      pending: { role: "viewer", read_policy: policy },
    }),
  ).toEqual({
    project_id: "project",
    action: "offer_access",
    role: "viewer",
    read_policy: policy,
  });
});

test("unavailable projects expose their reason and cannot be selected", () => {
  render(
    <InvitationProjectsTable
      rows={[
        {
          ...project,
          can_invite: false,
          unavailable_reason: "Only the project owner can invite people",
        },
      ]}
      knownRows={{}}
      choices={[]}
      disabled={false}
      onChange={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("checkbox", { name: "Select Research" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Only the project owner can invite people"),
  ).toBeVisible();
});

test("enforces 25 projects without dropping previous choices and allows keyboard removal", async () => {
  const user = userEvent.setup();
  const rows = Array.from({ length: 26 }, (_, index) => ({
    ...project,
    project_id: String(index),
    title: `Project ${index}`,
  }));
  function Harness() {
    const [choices, setChoices] = useState<InvitationProjectChoice[]>(
      rows.slice(0, 25).map((row) => defaultProjectChoice(row)!),
    );
    return (
      <InvitationProjectsTable
        rows={rows}
        knownRows={Object.fromEntries(rows.map((row) => [row.project_id, row]))}
        choices={choices}
        disabled={false}
        onChange={setChoices}
      />
    );
  }
  render(<Harness />);
  expect(
    screen.getByRole("checkbox", { name: "Select Project 25" }),
  ).toBeDisabled();
  const remove = screen.getByRole("button", { name: "Remove Project 0" });
  remove.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("checkbox", { name: "Select Project 25" }),
  ).toBeEnabled();
  await user.click(screen.getByRole("checkbox", { name: "Select Project 25" }));
  expect(
    screen
      .getAllByRole("checkbox")
      .filter((input) => (input as HTMLInputElement).checked),
  ).toHaveLength(25);
  expect(
    screen.getByRole("checkbox", { name: "Select Project 1" }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Select Project 0" }),
  ).toBeDisabled();
});

test("editing a viewer policy preserves newlines and never displays an empty policy as full access", async () => {
  const user = userEvent.setup();
  let latest: InvitationProjectChoice[] = [];
  function Harness() {
    const [choices, setChoices] = useState<InvitationProjectChoice[]>([
      {
        project_id: "project",
        action: "offer_access",
        role: "viewer",
        read_policy: { rules: [{ action: "include", path: "README.md" }] },
      },
    ]);
    return (
      <InvitationProjectsTable
        rows={[project]}
        knownRows={{ project }}
        choices={choices}
        disabled={false}
        onChange={(value) => {
          latest = value;
          setChoices(value);
        }}
      />
    );
  }
  render(<Harness />);
  const paths = screen.getByRole("textbox", {
    name: "Viewer file access for Research",
  });
  await user.clear(paths);
  expect(paths).toHaveValue("");
  await user.type(paths, "README.md{Enter}public/");
  expect(paths).toHaveValue("README.md\npublic/");
  expect(latest[0]).toMatchObject({
    read_policy: {
      rules: expect.arrayContaining([
        { action: "include", path: "README.md" },
        { action: "include", path: "public/**" },
      ]),
    },
  });
});
