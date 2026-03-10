import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorDisplay } from "../error-display";

describe("ErrorDisplay", () => {
  it("renders a close control for banner errors with onClose", () => {
    const onClose = jest.fn();
    render(<ErrorDisplay banner error="boom" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
