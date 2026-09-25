import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationSaveAlert } from "./organization-save-alert";

it("explains unsaved changes and offers a keyboard-accessible retry", async () => {
  const onRetry = jest.fn();
  render(
    <OrganizationSaveAlert
      error="Agent list changes were not saved."
      onRetry={onRetry}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your changes are still shown here, but may be lost if you reload this page.",
  );
  const retry = screen.getByRole("button", { name: "Retry save" });
  retry.focus();
  expect(retry).toHaveFocus();
  await userEvent.setup().keyboard("{Enter}");
  expect(onRetry).toHaveBeenCalledTimes(1);
});
