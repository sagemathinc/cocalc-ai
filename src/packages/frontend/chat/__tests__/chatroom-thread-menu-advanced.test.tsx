import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatRoomThreadMenu } from "../chatroom-thread-menu";

jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("../artifact-discovery", () => ({
  ArtifactBrowserModal: () => null,
}));

test("project chat exposes History and Maintenance in its advanced submenu", async () => {
  const user = userEvent.setup();
  const history = jest.fn(),
    maintenance = jest.fn();
  render(
    <ChatRoomThreadMenu
      actions={{} as any}
      threadKey="thread"
      plainLabel="Thread"
      openAppearanceModal={jest.fn()}
      openBehaviorModal={jest.fn()}
      openExportModal={jest.fn()}
      openImportModal={jest.fn()}
      openForkModal={jest.fn()}
      confirmResetThread={jest.fn()}
      confirmDeleteThread={jest.fn()}
      openHistory={history}
      openMaintenance={maintenance}
      buttonAriaLabel="Thread actions"
    />,
  );
  const trigger = screen.getByRole("button", { name: "Thread actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const advanced = await screen.findByRole("menuitem", {
    name: /Advanced \/ technical/,
  });
  await user.hover(advanced);
  const item = await screen.findByRole("menuitem", {
    name: "History",
    exact: true,
  });
  await user.click(item);
  expect(history).toHaveBeenCalledTimes(1);
  expect(maintenance).not.toHaveBeenCalled();
});
