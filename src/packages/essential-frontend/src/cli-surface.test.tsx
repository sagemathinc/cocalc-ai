/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CliSurface from "./cli-surface";

test("shows project-scoped CLI discovery and copies an exact command", async () => {
  const writeText = jest.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <CliSurface
      project={
        {
          project_id: "af027aca-e308-41c2-b528-a3e73de50996",
          title: "Research",
        } as any
      }
    />,
  );

  expect(screen.getByRole("heading", { name: "CoCalc CLI" })).toBeVisible();
  expect(
    screen.getByText("af027aca-e308-41c2-b528-a3e73de50996"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy command: List files" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      "cocalc project file list /home/user",
    ),
  );
});
