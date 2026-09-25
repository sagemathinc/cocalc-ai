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
    />,
  );
  const trigger = screen.getByRole("button", { name: "Organize agents" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("switch")).toBeNull();
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
