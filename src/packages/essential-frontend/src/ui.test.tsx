/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ChunkErrorBoundary } from "./ui";

function BrokenChunk(): never {
  throw new Error("Loading chunk failed");
}

test("contains an optional chunk failure and exposes local recovery", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation();
  render(
    <ChunkErrorBoundary label="Files">
      <BrokenChunk />
    </ChunkErrorBoundary>,
  );

  expect(
    screen.getByRole("heading", { name: "Files could not be displayed" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Reload CoCalc" })).toBeVisible();
  consoleError.mockRestore();
});
