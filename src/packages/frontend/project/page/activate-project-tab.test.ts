import { activateProjectTab } from "./activate-project-tab";
import {
  getActivityBarPanelMode,
  setActivityBarPanelMode,
} from "./activity-bar-storage";
jest.mock("./activity-bar-storage", () => ({
  getActivityBarPanelMode: jest.fn(),
  setActivityBarPanelMode: jest.fn(),
}));
const mode = getActivityBarPanelMode as jest.Mock;
const actions = {
  set_active_tab: jest.fn(),
  setFlyoutExpanded: jest.fn(),
  toggleFlyout: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
  mode.mockReturnValue("full");
});
it("respects full-page preference for navigation and ordinary clicks", () => {
  activateProjectTab(actions, "files", { flyout: "files" });
  expect(actions.set_active_tab).toHaveBeenCalledWith("files");
  expect(actions.setFlyoutExpanded).toHaveBeenCalledWith("files", false, false);
});
it("opens flyouts for navigation while clicks retain toggle behavior", () => {
  mode.mockReturnValue("flyout");
  activateProjectTab(actions, "files", { flyout: "files" });
  expect(actions.setFlyoutExpanded).toHaveBeenCalledWith("files", true);
  expect(actions.toggleFlyout).not.toHaveBeenCalled();
  activateProjectTab(actions, "files", { flyout: "files", toggle: true });
  expect(actions.toggleFlyout).toHaveBeenCalledWith("files");
});
it("honors noFullPage and modifier overrides", () => {
  activateProjectTab(actions, "active", {
    flyout: "active",
    noFullPage: true,
    event: { shiftKey: true },
  });
  expect(actions.set_active_tab).not.toHaveBeenCalled();
  expect(actions.setFlyoutExpanded).toHaveBeenCalledWith("active", true);
  activateProjectTab(actions, "files", {
    flyout: "files",
    event: { ctrlKey: true },
  });
  expect(setActivityBarPanelMode).toHaveBeenCalledWith("files", "flyout");
  mode.mockReturnValue("flyout");
  activateProjectTab(actions, "files", {
    flyout: "files",
    event: { shiftKey: true },
  });
  expect(setActivityBarPanelMode).toHaveBeenCalledWith("files", "full");
  expect(actions.set_active_tab).toHaveBeenCalledWith("files");
});
