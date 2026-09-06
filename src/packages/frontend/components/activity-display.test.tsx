import { fireEvent, render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ActivityDisplay } from "./activity-display";

jest.mock("./icon", () => ({ Icon: () => null }));
jest.mock("./close-x", () => ({
  CloseX: ({ on_close }: any) => (
    <button onClick={on_close}>Clear activity</button>
  ),
}));

test("activity popup pairs semantic surface and text and retains clearing", () => {
  const clear = jest.fn();
  const { container } = render(
    <ActivityDisplay
      activity={["Configuring student projects"]}
      on_clear={clear}
    />,
  );
  const style = container.firstElementChild!.getAttribute("style");
  expect(style).toContain(UI_COLORS.surface);
  expect(style).toContain(UI_COLORS.text);
  expect(style).toContain(UI_COLORS.border);
  expect(screen.getByText("Configuring student projects")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear activity" }));
  expect(clear).toHaveBeenCalledTimes(1);
});
