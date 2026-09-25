/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { PeerMessageCard, type PeerMessageEvent } from "./peer-message-card";
import { readablePeerMessage } from "./readable-peer-message";

test("shows the text of a structured peer message while retaining raw details", () => {
  const raw = JSON.stringify({
    kind: "request",
    text: "Please review the fix",
    correlation_id: "123",
  });
  expect(readablePeerMessage(raw)).toEqual({
    text: "Please review the fix",
    structured: true,
  });
  render(
    <PeerMessageCard
      event={
        {
          type: "peerMessage",
          target_name: "reviewer",
          body: raw,
          outcome: "accepted",
          attempt_id: "attempt-2",
        } as PeerMessageEvent
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Read message" }));
  expect(
    screen.getByRole("document", { name: "Message to @reviewer" }),
  ).toHaveTextContent("Please review the fix");
  expect(screen.getByText("Raw message")).toBeInTheDocument();
});

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
