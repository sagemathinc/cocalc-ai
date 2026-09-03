/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCodexLogPanel = jest.fn((_props: unknown) => (
  <section data-codex-attention-id="attention-1" tabIndex={-1} />
));

jest.mock("../codex-log-panel", () => ({
  __esModule: true,
  default: (props: unknown) => mockCodexLogPanel(props),
}));

import { AgentMessageStatus } from "../agent-message-status";

describe("AgentMessageStatus activity loading", () => {
  beforeEach(() => {
    mockCodexLogPanel.mockClear();
  });

  it("does not mount the full activity panel until the drawer opens", async () => {
    render(
      <AgentMessageStatus
        show
        generating
        durationLabel="0:10"
        date={1000}
        project_id="project-1"
        path="chat.chat"
        logRefs={{
          store: "acp-log/chat.chat",
          key: "thread:turn",
          subject: "project.project-1.acp-log.thread.turn",
          liveStream: "acp-live-log/chat.chat/thread/turn",
        }}
        activityContext={{} as any}
        activeDescendantThreadIds={["child-1", "child-2"]}
      />,
    );

    expect(mockCodexLogPanel).not.toHaveBeenCalled();
    expect(screen.getByText(/2 subagents working/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Codex activity details" }),
    );

    await waitFor(() => expect(mockCodexLogPanel).toHaveBeenCalled());
    expect(mockCodexLogPanel.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        events: undefined,
        liveLogStream: "acp-live-log/chat.chat/thread/turn",
        logEnabled: true,
      }),
    );
  });

  it("opens and focuses a notification-targeted attention request", async () => {
    render(
      <AgentMessageStatus
        show
        generating
        durationLabel="0:10"
        date={1000}
        logRefs={{}}
        activityContext={{} as any}
        openDrawerToken={1}
        focusAttentionId="attention-1"
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute(
        "data-codex-attention-id",
        "attention-1",
      ),
    );
  });
});
