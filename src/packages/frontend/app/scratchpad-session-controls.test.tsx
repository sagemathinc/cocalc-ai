/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createAppearanceStore } from "@cocalc/util/appearance-store";
import {
  APPEARANCE_STORAGE_KEY,
  parseStoredAppearance,
} from "@cocalc/util/appearance";
import { ScratchpadSessionControls } from "./scratchpad-session-controls";

let mockStore: ReturnType<typeof createAppearanceStore>;
jest.mock("@cocalc/util/appearance-browser", () => ({
  getBrowserAppearanceStore: () => mockStore,
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => null,
}));

test("scratchpads use local three-way appearance without an account writer", async () => {
  localStorage.clear();
  mockStore = createAppearanceStore({
    storage: localStorage,
    systemDark: true,
  });
  render(<ScratchpadSessionControls />);
  const select = screen.getByRole("combobox", { name: "Appearance" });
  expect(select).toHaveValue("system");
  select.focus();
  await act(async () => {
    fireEvent.change(select, { target: { value: "light" } });
  });
  expect(select).toHaveFocus();
  expect(mockStore.getSnapshot().resolved).toBe("light");
  expect(
    parseStoredAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY))
      ?.preference,
  ).toBe("light");
  await act(async () => {
    fireEvent.change(select, { target: { value: "system" } });
  });
  expect(mockStore.getSnapshot().resolved).toBe("dark");
  expect(screen.getByRole("button", { name: /Temporary/ })).toBeVisible();
});
