import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSidebarFilter } from "./sidebar-filter";

it("updates the sidebar filter without rerendering its parent", async () => {
  const parentRender = jest.fn();
  function Parent() {
    parentRender();
    return (
      <AgentSidebarFilter
        render={(search, input) => (
          <>
            {input}
            <div role="status">{search}</div>
          </>
        )}
      />
    );
  }

  render(<Parent />);
  const input = screen.getByRole("textbox", {
    name: "Filter agents or network tags",
  });
  input.focus();
  await userEvent.setup().keyboard("tag:sagejs");

  expect(input).toHaveValue("tag:sagejs");
  expect(screen.getByRole("status")).toHaveTextContent("tag:sagejs");
  expect(input).toHaveFocus();
  expect(parentRender).toHaveBeenCalledTimes(1);
});
