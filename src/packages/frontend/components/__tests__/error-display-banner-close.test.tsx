import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorDisplay } from "../error-display";

describe("ErrorDisplay", () => {
  it("renders a close control for banner errors with onClose", () => {
    const onClose = jest.fn();
    render(<ErrorDisplay banner error="boom" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows readable backend errors with technical details collapsed", () => {
    render(
      <ErrorDisplay
        error={
          "not authorized - callHub: subject='hub.account.user', name='projects.start', code='not_authorized'"
        }
      />,
    );

    expect(screen.getByText("not authorized")).toBeInTheDocument();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText(/subject='hub.account.user'/)).toBeInTheDocument();
  });
});
