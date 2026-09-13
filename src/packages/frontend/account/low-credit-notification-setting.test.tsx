import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LowCreditNotificationSetting } from "./low-credit-notification-setting";

let mockEnabled = false;
let mockCourseEnabled = false;
const mockSave = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: (name) =>
    name === "low_credit_notifications"
      ? mockEnabled
      : name === "low_course_credit_notifications"
        ? mockCourseEnabled
        : 10,
  useActions: () => ({ set_other_settings: mockSave }),
}));
it("saves opt-in and threshold using account settings with keyboard controls", async () => {
  const user = userEvent.setup();
  const view = render(<LowCreditNotificationSetting />);
  const checkbox = screen.getByRole("checkbox", {
    name: "Notify me when personal spendable credit falls below",
  });
  const input = screen.getByRole("spinbutton", {
    name: "Low personal credit threshold in USD",
  });
  expect(checkbox).not.toBeChecked();
  expect(input).toBeDisabled();
  await user.tab();
  expect(checkbox).toHaveFocus();
  await user.keyboard(" ");
  expect(mockSave).toHaveBeenLastCalledWith("low_credit_notifications", true);
  mockEnabled = true;
  view.rerender(<LowCreditNotificationSetting />);
  await user.tab();
  expect(input).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(mockSave).toHaveBeenLastCalledWith("low_credit_threshold_usd", 11);
});
it("offers an independently keyboard-operable course reminder", async () => {
  mockEnabled = false;
  mockCourseEnabled = false;
  const user = userEvent.setup();
  const view = render(<LowCreditNotificationSetting />);
  const checkbox = screen.getByRole("checkbox", {
    name: "Notify me when available course credit falls below",
  });
  const input = screen.getByRole("spinbutton", {
    name: "Low course credit threshold in USD",
  });
  expect(input).toBeDisabled();
  await user.tab();
  await user.tab();
  expect(checkbox).toHaveFocus();
  await user.keyboard(" ");
  expect(mockSave).toHaveBeenLastCalledWith(
    "low_course_credit_notifications",
    true,
  );
  mockCourseEnabled = true;
  view.rerender(<LowCreditNotificationSetting />);
  await user.tab();
  expect(input).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(mockSave).toHaveBeenLastCalledWith(
    "low_course_credit_threshold_usd",
    11,
  );
});
