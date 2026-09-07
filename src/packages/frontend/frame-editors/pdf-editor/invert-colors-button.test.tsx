import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { PDFInvertColorsButton } from "./invert-colors-button";

let mockValues: Record<string, boolean> = {};
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
  useRedux: () => ({ get: (id: string) => mockValues[id] }),
}));

it("toggles only this PDF view with keyboard input and exposes its state", async () => {
  mockValues = { other: true };
  const actions = {
    name: "pdf-test",
    toggle_pdf_dark_mode: jest.fn((id: string) => {
      mockValues[id] = !mockValues[id];
    }),
  };
  const view = () => (
    <IntlProvider locale="en">
      <PDFInvertColorsButton actions={actions} id="pdf" />
    </IntlProvider>
  );
  const { rerender } = render(view());
  const button = screen.getByRole("button", { name: "Invert page colors" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.querySelector('[data-icon="sun"]')).not.toBeNull();
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  rerender(view());
  expect(actions.toggle_pdf_dark_mode).toHaveBeenCalledWith("pdf");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.querySelector('[data-icon="moon"]')).not.toBeNull();
  expect(document.activeElement).toBe(button);
  await user.keyboard(" ");
  rerender(view());
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(mockValues.other).toBe(true);
});
