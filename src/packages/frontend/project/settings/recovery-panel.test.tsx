/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecoveryPanel } from "./recovery-panel";

const mockCreateSnapshot = jest.fn();

jest.mock("antd", () => ({
  Card: ({ children }: any) => <section>{children}</section>,
  Grid: { useBreakpoint: () => ({ md: false }) },
  Space: ({ children, style }: any) => <div style={style}>{children}</div>,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/project/backups/create", () => () => (
  <button type="button">Create Backup</button>
));
jest.mock("@cocalc/frontend/project/explorer/clone", () => () => (
  <button type="button">Clone</button>
));
jest.mock("@cocalc/frontend/project/recovery-status", () => ({
  ProjectRecoveryStatus: () => <div>Recovery status</div>,
}));
jest.mock("@cocalc/frontend/project/snapshots/create", () => () => (
  <button type="button" onClick={() => mockCreateSnapshot()}>
    Create Snapshot
  </button>
));
jest.mock("@cocalc/frontend/project/snapshots/restore", () => () => (
  <button type="button">Restore Snapshot</button>
));
jest.mock("./datastore", () => ({ Datastore: () => null }));
jest.mock("../runtime-capabilities", () => ({
  useProjectRuntimeCapabilities: () => ({ snapshots: true, backups: true }),
}));

it("stacks recovery actions at narrow widths and keeps them keyboard accessible", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <RecoveryPanel project_id="test-project" project={{} as any} />,
  );

  const layout = container.querySelector<HTMLElement>(
    '[style*="grid-template-columns"]',
  );
  expect(layout?.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  expect(screen.getAllByText("Recovery status")).toHaveLength(2);

  await user.tab();
  expect(screen.getByRole("button", { name: "Create Snapshot" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Restore Snapshot" }),
  ).toHaveFocus();
  expect(screen.getByRole("button", { name: "Create Backup" })).toBeVisible();
});
