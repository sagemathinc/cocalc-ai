import { fireEvent, render, screen } from "@testing-library/react";
import { RawJson } from "./util";

let mockResolved = "dark";
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: mockResolved }),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ editorTheme, value }: any) => (
    <pre data-theme={editorTheme}>{value}</pre>
  ),
}));

it("keeps expanded raw payment data visible while following appearance", () => {
  const props = { value: { id: "pm_example" }, defaultOpen: true };
  const { rerender } = render(<RawJson {...props} />);
  expect(screen.getByText(/pm_example/)).toHaveAttribute(
    "data-theme",
    "cocalc-dark",
  );
  mockResolved = "light";
  rerender(<RawJson {...props} />);
  expect(screen.getByText(/pm_example/)).toHaveAttribute(
    "data-theme",
    "cocalc-light",
  );
  const button = screen.getByRole("button", { name: "Raw" });
  button.focus();
  fireEvent.click(button);
  expect(screen.queryByText(/pm_example/)).toBeNull();
  expect(button).toHaveFocus();
});
