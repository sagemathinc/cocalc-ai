/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ComposerPillButton,
  ComposerProjectDirectoryButton,
  displayComposerWorkingDirectory,
} from "../composer-codex-controls";

test("shares the one-line project and directory trigger with keyboard access", async () => {
  const user = userEvent.setup();
  const onClick = jest.fn();
  render(
    <ComposerProjectDirectoryButton
      projectTitle="Research"
      directory="/home/user/work"
      displayedDirectory="~/work"
      onClick={onClick}
    />,
  );

  const button = screen.getByRole("button", {
    name: "Working directory: Research / /home/user/work",
  });
  expect(button).toHaveTextContent("Research / ~/work");
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("shares compact setting triggers and home-relative path labels", async () => {
  const user = userEvent.setup();
  const onClick = jest.fn();
  render(
    <ComposerPillButton aria-label="Change model" onClick={onClick}>
      gpt-5.6-luna
    </ComposerPillButton>,
  );

  await user.click(screen.getByRole("button", { name: "Change model" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(displayComposerWorkingDirectory("/home/user", "/home/user")).toBe("~");
  expect(displayComposerWorkingDirectory("/home/user/work", "/home/user")).toBe(
    "~/work",
  );
});
