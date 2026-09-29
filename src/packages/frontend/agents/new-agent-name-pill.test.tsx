/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAgentNamePill } from "./new-agent-name-pill";

function Pill({ problem }: { problem?: string }) {
  const [name, setName] = useState("agent-29");
  return <NewAgentNamePill name={name} onChange={setName} problem={problem} />;
}

test("the name pill opens a name editor and applies edits", async () => {
  const user = userEvent.setup();
  render(<Pill />);
  const pill = screen.getByRole("button", {
    name: "Agent name: agent-29. Change name",
  });
  expect(pill).not.toHaveAttribute("aria-invalid");
  pill.focus();
  await user.keyboard("{Enter}");
  const input = await screen.findByRole("textbox", { name: /Name/ });
  await user.clear(input);
  await user.type(input, "reviewer");
  expect(
    screen.getByRole("button", { name: "Agent name: reviewer. Change name" }),
  ).toHaveTextContent("@reviewer");
});

test("an invalid name is flagged on the pill", () => {
  render(<Pill problem="That name is already used" />);
  const pill = screen.getByRole("button", {
    name: "Agent name: agent-29. Change name",
  });
  expect(pill).toHaveAttribute("aria-invalid", "true");
  expect(pill.getAttribute("style")).toContain("--cocalc-ui-danger");
});
