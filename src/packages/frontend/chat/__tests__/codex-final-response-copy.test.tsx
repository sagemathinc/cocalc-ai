/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexFinalResponseCopy } from "../codex-final-response-copy";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";

jest.mock("@cocalc/frontend/components/copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

describe("CodexFinalResponseCopy", () => {
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
});
