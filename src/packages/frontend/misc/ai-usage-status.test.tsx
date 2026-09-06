import { render, screen } from "@testing-library/react";
import { CompactUsageBar } from "./ai-usage-status";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

it.each([0, 50, 100])("states %s percent used explicitly", (used) => {
  render(
    <CompactUsageBar label="5h" window={{ window: "5h", used, limit: 100 }} />,
  );
  expect(screen.getByText(`${used}% used`)).toBeVisible();
  expect(screen.getByRole("meter", { name: "5h AI usage" })).toHaveAttribute(
    "aria-valuenow",
    `${used}`,
  );
  if (!used) {
    for (const segment of screen.getByRole("meter").children) {
      expect(segment).toHaveStyle({ background: UI_COLORS.inset });
    }
  }
});

it("does not label missing usage as zero", () => {
  render(<CompactUsageBar label="7d" />);
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.queryByRole("meter")).toBeNull();
});
