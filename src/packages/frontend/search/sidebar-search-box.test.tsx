import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { focusSidebarSearch, SidebarSearchBox } from "./sidebar-search-box";

function Box({
  onSubmit = jest.fn(),
  onEscape,
}: {
  onSubmit?: (v: string) => void;
  onEscape?: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <SidebarSearchBox
        label="Search agents"
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onEscape={onEscape}
      />
      <div role="status">{value}</div>
    </>
  );
}

it("types to filter, Enter searches, Escape clears", async () => {
  const user = userEvent.setup();
  const onSubmit = jest.fn();
  const onEscape = jest.fn();
  render(<Box onSubmit={onSubmit} onEscape={onEscape} />);
  const box = screen.getByRole("searchbox", { name: "Search agents" });
  await user.type(box, "plot ");
  expect(screen.getByRole("status")).toHaveTextContent("plot");
  await user.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("plot");
  await user.keyboard("{Escape}");
  expect(box).toHaveValue("");
  expect(onEscape).toHaveBeenCalled();
});

it("the shortcut focuses the box, even before it mounts", () => {
  focusSidebarSearch();
  render(<Box />);
  expect(
    screen.getByRole("searchbox", { name: "Search agents" }),
  ).toHaveFocus();
});
