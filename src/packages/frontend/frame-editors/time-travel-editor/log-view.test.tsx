/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List } from "immutable";
import { render, screen } from "@testing-library/react";
import { LogView } from "./log-view";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
  TimeAgo: () => <span>timeago</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));

describe("time-travel log view", () => {
  it("leaves scrolling to the TimeTravel body rather than nesting a full-height scroller", () => {
    const { container } = render(
      <LogView
        actions={{ snapshotWallTime: () => 0 } as any}
        source="snapshots"
        versions={List(Array.from({ length: 100 }, (_, i) => i))}
        firstVersion={0}
        onSelectVersion={() => {}}
      />,
    );
    const list = container.firstElementChild as HTMLElement;
    expect(list.style.overflowY).toBe("");
    expect(list.style.height).toBe("");
    expect(screen.getByText("Snapshot 99")).toBeInTheDocument();
    expect(screen.getByText("Snapshot 0")).toBeInTheDocument();
  });
  it("themes selected and unselected history rows", () => {
    render(
      <LogView
        actions={{ snapshotWallTime: () => 0 } as any}
        source="snapshots"
        versions={List([1, 2])}
        firstVersion={0}
        currentVersion={2}
        onSelectVersion={() => {}}
      />,
    );
    for (const version of [1, 2]) {
      const row = screen.getByText(`Snapshot ${version}`).parentElement!
        .parentElement!;
      expect(row.style.background).toBe(
        version === 2 ? UI_COLORS.selected : UI_COLORS.surface,
      );
      expect(row.style.color).toBe(UI_COLORS.text);
      expect(row.style.border).toContain(
        version === 2 ? UI_COLORS.link : UI_COLORS.border,
      );
    }
  });
  const actions = {} as any;

  it("shows loading instead of the empty-state message while versions are loading", () => {
    render(
      <LogView
        actions={actions}
        source="snapshots"
        versions={List()}
        loading
        firstVersion={0}
        onSelectVersion={() => {}}
      />,
    );

    expect(screen.getByText("Loading...")).not.toBeNull();
    expect(screen.queryByText("No versions found.")).toBeNull();
  });

  it("shows the empty-state message once loading is complete and there are no versions", () => {
    render(
      <LogView
        actions={actions}
        source="snapshots"
        versions={List()}
        firstVersion={0}
        onSelectVersion={() => {}}
      />,
    );

    expect(screen.getByText("No versions found.")).not.toBeNull();
  });
});
