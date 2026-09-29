import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { ApiKeyScopeEditor, EMPTY_API_KEY_SCOPE } from "./api-key-scope-editor";

const projectMap = fromJS({
  first: {
    project_id: "first",
    title: "First project",
    users: { account: { group: "owner" } },
  },
  second: {
    project_id: "second",
    title: "Second project",
    users: { account: { group: "collaborator" } },
  },
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useMemo: React.useMemo,
  useState: React.useState,
  useTypedRedux: () => projectMap,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { account_id: "account" },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading</div>,
}));

function Editor() {
  const [scope, setScope] = React.useState(EMPTY_API_KEY_SCOPE);
  return <ApiKeyScopeEditor value={scope} onChange={setScope} />;
}

test("real add-project picker clears after each selection and can add another project", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const picker = screen.getByRole("combobox", { name: "Add project access" });
  for (const [index, title] of ["First project", "Second project"].entries()) {
    await user.click(picker);
    await user.type(picker, title);
    // Select by pointer through the real Ant Design dropdown, not a select mock.
    const option = await screen.findByTitle(title);
    await user.click(option);
    expect(
      await screen.findByRole("combobox", { name: `Project ${index + 1}` }),
    ).toBeInTheDocument();
    expect(picker).toHaveValue("");
    expect(picker).toHaveFocus();
    const control = picker.closest(".ant-select") as HTMLElement;
    expect(
      within(control).getByText("Select a project..."),
    ).toBeInTheDocument();
    expect(control.querySelector(".ant-select-selection-item")).toBeNull();
  }
});
