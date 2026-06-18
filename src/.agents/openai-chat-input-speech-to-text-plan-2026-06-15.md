# OpenAI Chat Input Speech-to-Text Plan

Status: implementation plan only
Scope: chat composer microphone dictation using OpenAI speech-to-text
Out of scope: browser-native Web Speech API, third-party STT providers, realtime voice assistant, speech output, non-chat editors

## Goal

Add a microphone button to the CoCalc chat input so a user can record a short
audio clip and insert the OpenAI transcription into the current chat composer.

This is not a voice-agent feature. It is a text-entry feature:

1. User clicks/holds a microphone control in the chat composer.
2. Browser records audio locally with `MediaRecorder`.
3. Browser uploads the bounded audio blob to a CoCalc backend RPC.
4. Backend calls OpenAI Audio transcriptions.
5. Browser inserts returned text into the existing chat input draft.
6. User reviews/edits text before sending.

## OpenAI API Choice

Use OpenAI request-based Audio transcriptions first, not Realtime transcription.

OpenAI’s speech-to-text guide describes the Audio API `transcriptions` endpoint
for bounded audio files and notes that file uploads are limited to 25 MB with
formats including `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, and `webm`.
The same guide says Realtime transcription is for live transcript deltas from a
microphone/media stream.

For chat input, request-based transcription is the right first implementation:

- Simpler backend and frontend lifecycle.
- Easy to review text before sending.
- No persistent realtime session or websocket state.
- No direct OpenAI credential exposure to the browser.
- Compatible with `MediaRecorder` output, especially `audio/webm`.

Default model:

- Use `gpt-4o-mini-transcribe` initially for lower cost.
- Make the model server-configurable, with `gpt-4o-transcribe` as the higher
  quality option.
- Do not use diarization for chat input.

References:

- OpenAI Speech to text guide: `https://developers.openai.com/api/docs/guides/speech-to-text`
- OpenAI Realtime transcription guide: `https://developers.openai.com/api/docs/guides/realtime-transcription`
- OpenAI Create transcription API reference: `https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create/`

## Product Behavior

Composer UI:

- Add a small microphone button near the existing chat composer buttons in
  `src/packages/frontend/chat/composer.tsx`.
- Hide the button when AI is disabled by policy for the project/account.
- Disable the button when the browser lacks `navigator.mediaDevices` or
  `MediaRecorder`.
- Show a tooltip such as `Dictate message`.
- While recording, show elapsed time and a clear stop/cancel affordance.
- After recording stops, show a short `Transcribing...` state on the button.
- Insert transcribed text into the existing draft, preserving existing text.
- Never auto-submit the transcript.

Insertion rule:

- If the composer is empty, set the draft to the transcript.
- If the composer already has text and does not end in whitespace, append
  `\n\n` plus the transcript.
- If the composer already ends in whitespace, append the transcript directly.
- Restore focus to the composer after insertion.

Failure behavior:

- Permission denied: show `Microphone access was denied.`
- No supported recorder MIME type: hide or disable with a tooltip.
- Backend/OpenAI error: show a specific error from the backend, not a generic
  toast.
- Empty transcript: show `No speech was detected.`

## Security And Privacy

Do not call OpenAI directly from the browser.

The browser should send audio only to CoCalc. The backend should:

- Resolve credentials server-side using the existing OpenAI credential routing
  model.
- Enforce account/project AI policy before accepting audio.
- Enforce file size and duration limits before forwarding to OpenAI.
- Avoid storing audio blobs unless a future debugging mode explicitly opts in.
- Never log audio bytes or full transcripts.
- Log only metadata needed for observability and abuse control: account,
  project, duration, byte size, model, success/failure class, and timing.

Suggested limits for the first release:

- Maximum duration: 60 seconds.
- Maximum upload size: 10 MB, below OpenAI’s 25 MB file limit.
- Accepted MIME types: `audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/wav`,
  with frontend preference for `audio/webm`.
- One in-flight transcription per composer.
- Conservative per-account/project rate limit, e.g. 20 transcription attempts
  per 10 minutes initially.

## Architecture

### Frontend

Add a focused hook/component pair:

- `src/packages/frontend/chat/audio/use-chat-audio-recorder.ts`
- `src/packages/frontend/chat/audio/dictate-button.tsx`

Responsibilities:

- Detect browser support.
- Pick a supported `MediaRecorder` MIME type.
- Request microphone permission only when the user clicks the button.
- Record audio chunks.
- Stop automatically at max duration.
- POST/RPC the audio blob to the backend.
- Insert returned text into the existing composer draft through the same state
  path as typing.

Do not embed transcription logic into generic markdown input components. This
feature is chat-specific at first.

### Backend RPC

Add a backend RPC such as:

```ts
transcribeChatAudio({
  project_id?: string;
  path?: string;
  thread_id?: string;
  filename: string;
  content_type: string;
  audio: Uint8Array | base64 string;
}): Promise<{
  text: string;
  model: string;
  duration_ms?: number;
}>
```

Likely placement:

- Prefer an existing server-side Conat API namespace used by browser-facing
  account/project operations.
- Keep the RPC backend-only for OpenAI access.
- If implemented under system/account APIs, route project authorization through
  the project’s owning bay, not through hub-local DB shortcuts.

Authorization checks:

- Require signed-in account.
- If `project_id` is present, require collaborator access using the routed
  project access helper, not a local-only project membership read.
- Use existing AI policy checks or expose a server-side equivalent of
  `projects.store.isAIAllowedByPolicy(project_id, "chat")`.
- Reject if the site/account/project has AI disabled.

Credential resolution:

- Reuse the existing OpenAI credential precedence where practical:
  project OpenAI API key, account OpenAI API key, then site OpenAI API key.
- Do not use ChatGPT subscription auth for this feature unless a separate
  product decision explicitly makes that valid for Audio API usage.
- Update `last_used` on the selected credential via the existing routed
  credential helpers.

### OpenAI Call

Backend implementation shape:

```ts
const transcription = await openai.audio.transcriptions.create({
  file,
  model: configuredModel ?? "gpt-4o-mini-transcribe",
  response_format: "json",
});
return { text: transcription.text.trim(), model };
```

Implementation detail:

- The OpenAI Node SDK expects a file-like upload object. Convert the received
  bytes into a temporary file, `Blob`, or SDK-supported upload wrapper in the
  server runtime.
- Delete any temporary file in `finally`.
- Set a backend timeout.
- Return a normalized error message for common failure classes: no credential,
  quota/rate limit, unsupported format, too large, provider unavailable.

## UI Details

Initial UI:

- Microphone icon button near Send/Queue/Steer.
- Idle state: `Dictate`.
- Recording state: red/danger or active styling with elapsed timer.
- Stop state: same button stops recording.
- Cancel can be a small secondary `x` while recording.
- Transcribing state: spinner on the microphone button.

Text insertion should be obvious:

- After insertion, optionally flash a subtle `Transcribed audio inserted`
  message near the composer.
- Keep cursor at the end of inserted text.

Accessibility:

- Button has `aria-label`.
- Recording state announces elapsed time in the label/title.
- Keyboard users can start/stop via the button.
- Do not require press-and-hold; click-to-toggle is more accessible.

## Lite / cocalc-plus

The first implementation should work in Lite/cocalc-plus if the backend has an
OpenAI key path available, but it must not assume `/home/user` or a project-host
file path.

Rules:

- The audio upload is an RPC payload, not a project file upload.
- No dependency on project filesystem location.
- If Lite lacks a configured OpenAI key, show the same credential/setup error
  as other OpenAI-backed chat features.

## Tests

Frontend unit tests:

- Button hidden/disabled when browser recording APIs are unavailable.
- Clicking starts recording only after user action.
- Stop sends a blob and inserts returned text.
- Existing draft insertion preserves text and appends with correct separator.
- Cancel does not call backend and does not mutate draft.
- Backend error leaves draft unchanged and shows specific error.

Backend tests:

- Reject unsigned requests.
- Reject missing project access.
- Reject AI-disabled policy.
- Reject unsupported MIME type.
- Reject oversized audio.
- Calls OpenAI transcription with configured model and upload file.
- Deletes temporary file after success and failure.
- Uses routed credential selection and does not expose key in logs/errors.

Integration/browser smoke:

- In a real browser session, microphone permission prompt appears only after
  clicking the microphone button.
- A mocked backend transcript inserts into the chat composer.
- Send still uses the existing chat send path after insertion.

## Rollout Plan

Phase 1: Backend and mockable frontend plumbing

- Add the backend RPC with OpenAI transcription behind a feature flag.
- Add frontend recorder hook and tests with mocked media APIs.
- Add composer button hidden unless feature flag and AI policy allow it.

Phase 2: Internal dogfood

- Enable for development/staging only.
- Validate Chrome, Safari, Firefox, and mobile Safari recording format support.
- Tune MIME type preference order.
- Confirm transcription errors are actionable.

Phase 3: Limited production release

- Enable for logged-in users with OpenAI-backed AI enabled.
- Keep max duration at 60 seconds.
- Track usage and error rates.
- Add a kill switch independent of general AI if needed.

Phase 4: Optional improvements

- Language hint selector only if real usage shows language detection problems.
- Push-to-talk keyboard shortcut only after click-to-toggle is stable.
- Realtime transcription only if users need live partial text; otherwise keep
  request-based transcription.

## Acceptance Criteria

- Users can dictate into the chat composer and review/edit before sending.
- No OpenAI API key is ever exposed to the browser.
- The feature respects site/account/project AI disablement.
- Audio is bounded, transient, and not stored.
- Failure messages are specific.
- Works in ordinary chat rooms and external side chat without changing send
  semantics.
- Implementation does not introduce a general audio feature outside chat input.
