import { render, screen } from "@testing-library/react";
import { DiffRenderBoundary } from "./render-boundary";

test("renderer failure offers recovery without referring to the removed Classic mode", () => {
  function Broken(): never {
    throw Error("renderer failed");
  }
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <DiffRenderBoundary>
        <Broken />
      </DiffRenderBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Try reopening this view or reloading the page.",
    );
    expect(screen.queryByText(/Classic/)).toBeNull();
  } finally {
    logged.mockRestore();
  }
});
