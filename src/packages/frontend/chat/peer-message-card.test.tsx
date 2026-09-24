/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { PeerMessageCard, type PeerMessageEvent } from "./peer-message-card";

test("reveals the full peer message without opening delivery details", () => {
  const body = "A long message that should remain readable when expanded.";
  render(
    <PeerMessageCard
      event={
        {
          type: "peerMessage",
          target_name: "reviewer",
          body,
          outcome: "accepted",
          attempt_id: "attempt-1",
        } as PeerMessageEvent
      }
    />,
  );
  const read = screen.getByRole("button", { name: "Read message" });
  expect(read).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(read);
  expect(
    screen.getByRole("document", { name: "Message to @reviewer" }),
  ).toHaveTextContent(body);
  expect(screen.getByRole("button", { name: "Hide message" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Hide message" }));
  expect(
    screen.queryByRole("document", { name: "Message to @reviewer" }),
  ).not.toBeInTheDocument();
});
