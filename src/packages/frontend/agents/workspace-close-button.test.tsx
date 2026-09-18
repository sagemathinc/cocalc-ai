/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentWorkspaceCloseButton } from "./workspace-close-button";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden>{name}</span>,
}));

it("keeps the close control on the themed header surface", () => {
  const onClose = jest.fn();
  render(
    <AgentWorkspaceCloseButton
      agentPath="review.chat"
      color="#ffffff"
      onClose={onClose}
    />,
  );

  const button = screen.getByRole("button", {
    name: "Close workspace for review.chat",
  });
  expect(button).toHaveClass("ant-btn-text");
  expect(button).toHaveStyle({ color: "#ffffff" });

  fireEvent.click(button);
  expect(onClose).toHaveBeenCalledTimes(1);
});
