import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSidebarFilter } from "./sidebar-filter";

function View({ query = "" }: { query?: string }) {
  return (
    <AgentSidebarFilter
      query={query}
      render={({ queries, input, panelOpen, setPanelOpen }) => (
        <>
          <button onClick={() => setPanelOpen(!panelOpen)}>panel</button>
          {input}
          <div role="status">{queries.join("|")}</div>
        </>
      )}
    />
  );
}

it("the sticky filter applies only while the organize panel is open", async () => {
  const user = userEvent.setup();
  render(<View query="john" />);
  const input = screen.getByRole("textbox", {
    name: "Filter agents or network tags",
  });
  input.focus();
  await user.keyboard("tag:sagejs");
  expect(input).toHaveValue("tag:sagejs");
  // Closed panel: only the search box's text.
  expect(screen.getByRole("status")).toHaveTextContent(/^john$/);
  await user.click(screen.getByRole("button", { name: "panel" }));
  expect(screen.getByRole("status")).toHaveTextContent("john|tag:sagejs");
});
