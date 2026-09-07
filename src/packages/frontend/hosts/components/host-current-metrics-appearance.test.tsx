import { render } from "@testing-library/react";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { HostCurrentMetrics } from "./host-current-metrics";

describe("host resource appearance", () => {
  it.each([
    { compact: false, dense: false },
    { compact: true, dense: false },
    { compact: true, dense: true },
  ])("themes the resource surface for %j", (layout) => {
    const host = {
      id: "host-1",
      name: "Test host",
      status: "running",
      metrics: { current: { cpu_percent: 25, memory_used_percent: 50 } },
    } as Host;
    const { container } = render(
      <HostCurrentMetrics host={host} {...layout} />,
    );
    expect(container.firstElementChild).toHaveStyle({
      background: UI_COLORS.surface,
      color: UI_COLORS.text,
    });
    const progress = container.querySelectorAll('[role="progressbar"]');
    expect(progress.length).toBeGreaterThan(0);
    for (const bar of progress) {
      expect(bar).toHaveAccessibleName();
    }
  });
});
