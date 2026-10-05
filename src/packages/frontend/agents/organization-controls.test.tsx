import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentOrganizationControls } from "./organization-controls";

jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

test("organization options are quiet until opened and Escape restores focus", async () => {
  const user = userEvent.setup();
  const onMode = jest.fn();
  const onGroupByProject = jest.fn();
  render(
    <AgentOrganizationControls
      mode="recent"
      groupByProject={false}
      onMode={onMode}
      onGroupByProject={onGroupByProject}
      onNewAgent={jest.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Organize agents" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("switch")).toBeNull();
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.click(screen.getByText("Custom"));
  expect(onMode).toHaveBeenCalledWith("custom");
  await user.click(
    screen.getByRole("switch", { name: "Group agents by project" }),
  );
  expect(onGroupByProject).toHaveBeenCalledWith(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("switch")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("New agent comes right below the Agents heading, beside the organize button", async () => {
  const user = userEvent.setup();
  const onNewAgent = jest.fn();
  render(
    <>
      <AgentOrganizationControls
        mode="recent"
        groupByProject={false}
        onMode={jest.fn()}
        onGroupByProject={jest.fn()}
        onNewAgent={onNewAgent}
      />
      <input aria-label="Filter agents" />
    </>,
  );
  const heading = screen.getByText("Agents");
  const create = screen.getByRole("button", { name: "New agent" });
  const filter = screen.getByRole("textbox", { name: "Filter agents" });
  expect(heading.compareDocumentPosition(create)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(create.compareDocumentPosition(filter)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const organize = screen.getByRole("button", { name: "Organize agents" });
  // Same row: no line of its own for the organize button.
  expect(create.parentElement).toBe(organize.parentElement);
  await user.tab();
  expect(create).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onNewAgent).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("switch")).toBeNull();
  await user.tab();
  expect(organize).toHaveFocus();
  await user.tab();
  expect(filter).toHaveFocus();
});
