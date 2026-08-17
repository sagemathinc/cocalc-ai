/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  clearRecentFiles,
  readRecentFiles,
  readShowHidden,
  recordRecentFile,
  writeShowHidden,
} from "./recent-files";

beforeEach(() => localStorage.clear());

test("stores a bounded deduplicated account-scoped recent list", () => {
  recordRecentFile("account-a", {
    path: "/home/user/a.py",
    projectId: "project-a",
    projectTitle: "A",
  });
  recordRecentFile("account-a", {
    path: "/home/user/a.py",
    projectId: "project-a",
    projectTitle: "Renamed",
  });

  expect(readRecentFiles("account-a")).toHaveLength(1);
  expect(readRecentFiles("account-a")[0]).toMatchObject({
    path: "/home/user/a.py",
    projectTitle: "Renamed",
  });
  expect(readRecentFiles("account-b")).toEqual([]);
  clearRecentFiles("account-a", "project-a");
  expect(readRecentFiles("account-a")).toEqual([]);
});

test("persists the account-scoped hidden-file preference", () => {
  expect(readShowHidden("account-a")).toBe(false);
  writeShowHidden("account-a", true);
  expect(readShowHidden("account-a")).toBe(true);
  expect(readShowHidden("account-b")).toBe(false);
});
