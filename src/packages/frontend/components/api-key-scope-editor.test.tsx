import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { ApiKeyScopeEditor, EMPTY_API_KEY_SCOPE } from "./api-key-scope-editor";

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: ({
    ariaLabel,
    exclude = [],
    onChange,
    value,
  }: {
    ariaLabel: string;
    exclude?: string[];
    onChange: (id: string) => void;
    value?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Select a project</option>
      {[
        ["22222222-2222-4222-8222-222222222222", "Project B"],
        ["33333333-3333-4333-8333-333333333333", "Project C"],
      ]
        .filter(([id]) => !exclude.includes(id) || id === value)
        .map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
    </select>
  ),
}));

function ControlledEditor() {
  const [scope, setScope] = useState<ApiKeyScope>(EMPTY_API_KEY_SCOPE);
  return (
    <>
      <ApiKeyScopeEditor value={scope} onChange={setScope} />
      <output data-testid="scope">{JSON.stringify(scope)}</output>
    </>
  );
}

test("scope editor keeps account and project grants independent", async () => {
  render(<ControlledEditor />);
  fireEvent.click(screen.getByRole("checkbox", { name: "List my projects" }));
  fireEvent.change(
    screen.getByRole("combobox", { name: "Add project access" }),
    {
      target: { value: "22222222-2222-4222-8222-222222222222" },
    },
  );
  expect(screen.getByRole("combobox", { name: "Project 1" })).toHaveValue(
    "22222222-2222-4222-8222-222222222222",
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Whole project" }));
  const directories = screen.getByRole("textbox", {
    name: "Allowed directories",
  });
  fireEvent.change(directories, { target: { value: "docs\nnotes" } });
  expect(JSON.parse(screen.getByTestId("scope").textContent ?? "{}")).toEqual({
    version: 1,
    account: ["project:list"],
    projects: [
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        capabilities: ["file:read", "project:read"],
        viewer_read_roots: ["docs", "notes"],
      },
    ],
  });
  fireEvent.click(screen.getByRole("radio", { name: "Full runtime" }));
  expect(
    screen.queryByRole("textbox", { name: "Allowed directories" }),
  ).toBeNull();
  const remove = screen.getByRole("button", { name: "Remove project 1" });
  remove.focus();
  expect(remove).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(
    JSON.parse(screen.getByTestId("scope").textContent ?? "{}").projects,
  ).toEqual([]);
  expect(
    screen.getByRole("checkbox", { name: "List my projects" }),
  ).toBeChecked();
});
