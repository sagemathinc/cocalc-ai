/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCodexLogPanel = jest.fn((_props: unknown) => (
  <section
    data-testid="attention-target"
    data-codex-attention-id="attention-1"
    tabIndex={-1}
  />
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

  it("cancels saved scroll restoration before focusing an attention request", async () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = window.requestAnimationFrame;
    const cancelAnimationFrame = window.cancelAnimationFrame;
    const scrollIntoView = HTMLElement.prototype.scrollIntoView;
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    window.cancelAnimationFrame = jest.fn();
    HTMLElement.prototype.scrollIntoView = jest.fn(function () {
      if (this.parentElement) {
        this.parentElement.scrollTop = 250;
      }
    });

    try {
      const props = {
        show: true,
        generating: true,
        durationLabel: "0:10",
        date: 2000,
        project_id: "scroll-project",
        path: "scroll.chat",
        logRefs: {},
        activityContext: {} as any,
      };
      const first = render(<AgentMessageStatus {...props} />);
      fireEvent.click(
        screen.getByRole("button", { name: "Open Codex activity details" }),
      );
      const firstTarget = await screen.findByTestId("attention-target");
      const firstScrollNode = firstTarget.parentElement as HTMLDivElement;
      Object.defineProperties(firstScrollNode, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 1000 },
      });
      firstScrollNode.scrollTop = 900;
      fireEvent.scroll(firstScrollNode);
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(".ant-drawer-close")!,
      );
      first.unmount();
      queuedFrames.length = 0;

      render(
        <AgentMessageStatus
          {...props}
          openDrawerToken={1}
          focusAttentionId="attention-1"
        />,
      );
      const target = await screen.findByTestId("attention-target");
      await waitFor(() => expect(document.activeElement).toBe(target));
      const scrollNode = target.parentElement as HTMLDivElement;
      expect(scrollNode.scrollTop).toBe(250);

      for (let i = 0; i < 100 && queuedFrames.length > 0; i += 1) {
        queuedFrames.shift()?.(i);
      }
      expect(scrollNode.scrollTop).toBe(250);
    } finally {
      window.requestAnimationFrame = requestAnimationFrame;
      window.cancelAnimationFrame = cancelAnimationFrame;
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
    }
  });
});
