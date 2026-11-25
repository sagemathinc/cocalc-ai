import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeUsageRefreshSetting } from "./claude-usage-refresh-setting";

let mockValue: unknown = undefined;
const mockSave = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: (name) =>
    name === "claude_usage_refresh" ? mockValue : undefined,
  redux: { getActions: () => ({ set_other_settings: mockSave }) },
}));

beforeEach(() => {
  mockValue = undefined;
  mockSave.mockClear();
});

it("is off when never set, says what turning it on does, and saves the choice", async () => {
  const user = userEvent.setup();
  const view = render(<ClaudeUsageRefreshSetting />);
  const toggle = screen.getByRole("switch", {
    name: /sends a small request .* uses a little of that subscription's allowance/,
  });
  expect(toggle).not.toBeChecked();
  expect(mockSave).not.toHaveBeenCalled();
  await user.click(toggle);
  expect(mockSave).toHaveBeenLastCalledWith("claude_usage_refresh", true);
  mockValue = true;
  view.rerender(<ClaudeUsageRefreshSetting />);
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(mockSave).toHaveBeenLastCalledWith("claude_usage_refresh", false);
});

it("only true turns it on", () => {
  mockValue = "true";
  render(<ClaudeUsageRefreshSetting />);
  expect(screen.getByRole("switch")).not.toBeChecked();
});
