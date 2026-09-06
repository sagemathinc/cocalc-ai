/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { SwitchToClassicButton } from "./frame-type-toggle";
const set_frame_type = jest.fn();
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }) => children,
}));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ id: "active", actions: { set_frame_type } }),
}));
it.each([false, true])(
  "identifies Studio and offers an accessible exit (iconsOnly=%s)",
  (iconsOnly) => {
    render(<SwitchToClassicButton iconsOnly={iconsOnly} />);
    expect(screen.getByText("Studio (experimental)")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Return to Classic" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(set_frame_type).toHaveBeenCalledWith(
      "active",
      "jupyter_cell_notebook",
    );
  },
);
