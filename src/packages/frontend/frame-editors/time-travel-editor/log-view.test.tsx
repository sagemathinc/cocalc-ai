/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List } from "immutable";
import { render, screen } from "@testing-library/react";
import { LogView } from "./log-view";

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
  TimeAgo: () => <span>timeago</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));

describe("time-travel log view", () => {
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
