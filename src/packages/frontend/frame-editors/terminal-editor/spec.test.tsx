/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { terminal } from "./terminal-spec";

const mockLoadTerminal = jest.fn();
const mockTerminalProps = jest.fn();

jest.mock("./terminal", () => {
  mockLoadTerminal();
  return {
    TerminalFrame: (props) => {
      mockTerminalProps(props);
      return <div role="region" aria-label="Terminal frame" />;
    },
  };
});

it("loads the terminal component only when a frame renders, forwarding its props", async () => {
  expect(mockLoadTerminal).not.toHaveBeenCalled();
  const props = { id: "terminal-frame", actions: {}, is_visible: true };
  render(createElement(terminal.component, props));
  expect(
    await screen.findByRole("region", { name: "Terminal frame" }),
  ).toBeTruthy();
  expect(mockLoadTerminal).toHaveBeenCalledTimes(1);
  expect(mockTerminalProps).toHaveBeenCalledWith(
    expect.objectContaining(props),
  );
});
