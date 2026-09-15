import { render, screen } from "@testing-library/react";
import { DictateButton } from "./dictate-button";
import { CodexFinalResponseCopy } from "../codex-final-response-copy";
import { useChatAudioRecorder } from "./use-chat-audio-recorder";

jest.mock("@cocalc/frontend/lite", () => ({ lite: true }));
jest.mock("./use-chat-audio-recorder", () => ({
  useChatAudioRecorder: jest.fn(),
}));
jest.mock("./chat-speech-player", () => ({ startChatSpeech: jest.fn() }));

it("omits Lite microphone and speaker controls without mounting a recorder", () => {
  render(
    <>
      <DictateButton session={0} inputControlRef={{ current: null }} />
      <CodexFinalResponseCopy value="An answer" />
    </>,
  );
  expect(useChatAudioRecorder).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /dictat/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /read.*aloud/i })).toBeNull();
  // Removing speech must not remove the adjacent, keyboard-accessible copy UI.
  const copy = screen.getByRole("button", { name: "Copy final response" });
  copy.focus();
  expect(document.activeElement).toBe(copy);
});
