/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ManagedCpuHistoryModal } from "./managed-cpu-history";

jest.mock("antd", () => ({
  Alert: () => null,
  Button: ({ children }) => <button>{children}</button>,
  Empty: () => null,
  Modal: ({ children }) => <div>{children}</div>,
  Segmented: () => null,
  Space: ({ children }) => <div>{children}</div>,
  Spin: () => null,
  Tag: ({ children }) => <span>{children}</span>,
  Typography: { Text: ({ children }) => <span>{children}</span> },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }) => children,
}));
jest.mock("@cocalc/frontend/components/error", () => () => null);
jest.mock("./managed-egress-recent-events", () => ({
  ManagedEgressRecentEventsList: () => null,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          getManagedCpuAdminHistory: async () => ({
            start: "2026-09-06T00:00:00Z",
            end: "2026-09-06T01:00:00Z",
            total_cpu_seconds: 1800,
            top_accounts: [],
            top_projects: [],
            recent_events: [],
            points: [
              {
                start: "2026-09-06T00:00:00Z",
                end: "2026-09-06T01:00:00Z",
                cpu_seconds: 1800,
              },
            ],
          }),
        },
      },
    },
  },
}));

it("themes the SVG line, hover panel, and secondary copy", async () => {
  render(<ManagedCpuHistoryModal open onClose={() => {}} />);
  const chart = await screen.findByLabelText("Managed CPU history");
  expect(chart.querySelector("polyline")?.getAttribute("stroke")).toBe(
    UI_COLORS.link,
  );
  const wrapper = chart.parentElement!;
  jest.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 560,
    height: 160,
    right: 560,
    bottom: 160,
    toJSON: () => ({}),
  });
  fireEvent.mouseMove(wrapper, { clientX: 100 });
  const hover = wrapper.querySelector(
    'div[style*="pointer-events"]',
  ) as HTMLElement;
  expect(hover.style.background).toBe(UI_COLORS.elevated);
  expect(hover.style.color).toBe(UI_COLORS.text);
  expect(screen.getByText(/Managed CPU is sampled/).style.color).toBe(
    UI_COLORS.secondary,
  );
  fireEvent.mouseLeave(wrapper);
  expect(wrapper.querySelector('div[style*="pointer-events"]')).toBeNull();
});
