import { Map } from "immutable";
import { projectLiveVoiceMessages } from "./live-voice-messages";
import type { ChatMessage } from "./types";

const message: ChatMessage = {
  event: "chat",
  message_id: "message-1",
  thread_id: "thread-1",
  sender_id: "account-1",
  date: "2026-09-25T00:00:00.000Z",
  history: [
    {
      content: "Current text",
      date: "2026-09-25T00:00:01.000Z",
      author_id: "account-1",
    },
    {
      content: "Old text",
      date: "2026-09-25T00:00:00.000Z",
      author_id: "account-1",
    },
  ],
};

it("uses the newest revision for voice history and results", () => {
  expect(projectLiveVoiceMessages([message], "thread-1")[0].content).toBe(
    "Current text",
  );
});

it("exposes the compact preview stream without full activity references", () => {
  const projected = projectLiveVoiceMessages(
    [
      {
        ...message,
        acp_live_preview_stream: "preview-only",
        acp_live_log_stream: "full-stream",
        acp_log_store: "full-store",
        acp_log_key: "full-key",
      },
    ],
    "thread-1",
  )[0];
  expect(projected.acp_live_preview_stream).toBe("preview-only");
  expect(projected.acp_live_log_stream).toBeUndefined();
  expect(projected.acp_log_store).toBeUndefined();
  expect(projected.acp_log_key).toBeUndefined();
});

it.each([
  ["queue", "queued"],
  ["queued", "queued"],
  ["sending", "queued"],
  ["sent", "queued"],
  ["running", "running"],
  ["not-sent", "error"],
  ["error", "error"],
  ["interrupted", "interrupted"],
  ["done", "complete"],
])(
  "preserves ACP %s as %s instead of assuming completion",
  (acp_state, state) => {
    expect(
      projectLiveVoiceMessages([{ ...message, acp_state }], "thread-1")[0],
    ).toMatchObject({
      state,
      generating: state === "running",
    });
  },
);

it("uses runtime error state even when a persisted generating flag is stale", () => {
  expect(
    projectLiveVoiceMessages(
      [
        {
          ...message,
          generating: true,
          acp_state: "running",
          acp_thread_id: "agent-1",
        },
      ],
      "thread-1",
      Map({ "message:message-1": "error" }),
    )[0],
  ).toMatchObject({ state: "error", generating: false, role: "agent" });
});

it("preserves interrupted agent state and does not label system messages human", () => {
  expect(
    projectLiveVoiceMessages(
      [
        { ...message, acp_interrupted: true, generating: true },
        { ...message, sender_id: "__system__" },
      ],
      "thread-1",
    ),
  ).toMatchObject([
    { state: "interrupted", generating: false },
    { role: "system" },
  ]);
});
