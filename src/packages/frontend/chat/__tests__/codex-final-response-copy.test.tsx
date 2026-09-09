/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexFinalResponseCopy } from "../codex-final-response-copy";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import { startChatSpeech } from "../audio/chat-speech-player";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

jest.mock("../audio/chat-speech-player", () => ({
  startChatSpeech: jest.fn(async () => undefined),
}));

describe("CodexFinalResponseCopy", () => {
  beforeEach(() => {
    localStorage.setItem("cocalc-chat-speech-output-disclosed", "yes");
  });

  afterEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("copies only the final response using the rich Markdown clipboard type", async () => {
    render(<CodexFinalResponseCopy value="**Final** response" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy final response" }),
    );

    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith({
        text: "**Final** response",
        markdown: true,
      }),
    );
  });

  it("starts read aloud with message context", () => {
    render(
      <CodexFinalResponseCopy
        value="**Final** response"
        projectId="project-1"
        path="chat.chat"
        threadId="thread-1"
        messageId="message-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Read this response aloud" }),
    );

    expect(startChatSpeech).toHaveBeenCalledWith({
      paneId: undefined,
      markdown: "**Final** response",
      projectId: "project-1",
      path: "chat.chat",
      threadId: "thread-1",
      messageId: "message-1",
      title: "Final response",
    });
  });
});
