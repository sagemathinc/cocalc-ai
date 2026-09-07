/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  async (iconsOnly) => {
    set_frame_type.mockClear();
    render(<SwitchToClassicButton iconsOnly={iconsOnly} />);
    const button = screen.getByRole("button", { name: "Studio", exact: true });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(set_frame_type).not.toHaveBeenCalled();
    const back = await screen.findByRole("button", {
      name: "Return to classic",
    });
    fireEvent.keyDown(back, { key: "Escape" });
    await waitFor(() =>
      expect(button).toHaveAttribute("aria-expanded", "false"),
    );
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(
      await screen.findByRole("button", { name: "Stay in Studio" }),
    );
    expect(set_frame_type).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(
      await screen.findByRole("button", { name: "Return to classic" }),
    );
    expect(set_frame_type).toHaveBeenCalledWith(
      "active",
      "jupyter_cell_notebook",
    );
  },
);
