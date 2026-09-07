import { fireEvent, render, screen } from "@testing-library/react";

import { HostConfigChip } from "./host-configuration-cell";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

describe("HostConfigChip", () => {
  it.each([
    ["default", UI_COLORS.surface, UI_COLORS.text],
    ["blue", UI_COLORS.infoBg, UI_COLORS.link],
    ["amber", UI_COLORS.warningBg, UI_COLORS.warning],
    ["muted", UI_COLORS.inset, UI_COLORS.secondary],
  ] as const)(
    "uses theme-aware colors for %s chips",
    (tone, background, color) => {
      render(
        <HostConfigChip
          icon={<span aria-hidden>icon</span>}
          label="Machine"
          tone={tone}
          onClick={() => {}}
        />,
      );
      expect(screen.getByRole("button")).toHaveStyle({ background });
      expect(screen.getByText("Machine")).toHaveStyle({ color });
    },
  );

  it("is keyboard-operable when it opens configuration details", () => {
    const onClick = jest.fn();
    render(
      <HostConfigChip
        icon={<span aria-hidden>icon</span>}
        label="e2-standard-2"
        detail="2 vCPU · 8 GB RAM"
        ariaLabel="View configuration for compute-vm"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole("button", {
      name: "View configuration for compute-vm",
    });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);

    expect(button).toHaveFocus();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2 vCPU · 8 GB RAM")).toBeVisible();
  });

  it("remains non-interactive when no detail action is provided", () => {
    render(
      <HostConfigChip
        icon={<span aria-hidden>icon</span>}
        label="us-west1-a"
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("us-west1-a")).toBeVisible();
  });
});
