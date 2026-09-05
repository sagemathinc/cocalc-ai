/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createAppearanceStore } from "@cocalc/util/appearance-store";
import { AppearanceControl } from "./control";

let mockStore: ReturnType<typeof createAppearanceStore>;
jest.mock("@cocalc/util/appearance-browser", () => ({
  getBrowserAppearanceStore: () => mockStore,
}));

beforeEach(() => {
  mockStore = createAppearanceStore({ systemDark: true });
});

test("exposes all three choices and retains keyboard focus during live changes", () => {
  render(<AppearanceControl />);
  const select = screen.getByRole("combobox", { name: "Appearance" });
  expect(select).toHaveValue("system");
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["System", "Light", "Dark"]);
  select.focus();
  expect(select).toHaveFocus();
  fireEvent.change(select, { target: { value: "light" } });
  expect(select).toHaveValue("light");
  expect(select).toHaveFocus();
  act(() => mockStore.setSystemDark(false));
  expect(select).toHaveValue("light");
  fireEvent.change(select, { target: { value: "system" } });
  act(() => mockStore.setSystemDark(true));
  expect(select).toHaveValue("system");
  expect(mockStore.getSnapshot().resolved).toBe("dark");
});

test("save failures stay available rather than disappearing in a transient toast", async () => {
  mockStore.receiveAccount("alice", "light", async () => {
    throw Error("offline");
  });
  render(<AppearanceControl />);
  const select = screen.getByRole("combobox", { name: "Appearance" });
  await act(async () => {
    fireEvent.change(select, { target: { value: "dark" } });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(select).toHaveValue("dark");
  select.focus();
  fireEvent.keyDown(select, { key: "Escape" });
  expect(select).toHaveFocus();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("compact shell control retains a named native selector and three choices", () => {
  render(<AppearanceControl compact />);
  const select = screen.getByRole("combobox", { name: "Appearance" });
  select.focus();
  fireEvent.change(select, { target: { value: "dark" } });
  expect(select).toHaveFocus();
  expect(select).toHaveValue("dark");
  expect(screen.getByRole("option", { name: "System" })).toBeInTheDocument();
});
