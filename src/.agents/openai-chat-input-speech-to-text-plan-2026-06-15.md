# Agent Chat Speech Input And Output Plan

Status: revised implementation plan
Originally written: 2026-06-15
Last reviewed: 2026-09-08
Scope: speech input and read-aloud output in CoCalc agent chat on desktop and
mobile web

## Decision Summary

Speech is now a baseline chat capability, not an optional dictation experiment.
Implement it in two independently shippable paths:

1. **Dictate** records a bounded clip, transcribes it, and inserts editable text
   at the current composer selection. It never submits automatically.
2. **Read aloud** converts a completed agent answer to speech and exposes a
   persistent, compact playback bar with play/pause, stop, speed, and progress.

Do not start with a full-duplex voice agent. OpenAI Realtime over WebRTC is the
right eventual architecture for low-latency conversation, but it introduces a
second agent session, interruption semantics, transcript reconciliation, and a
different cost and authorization surface. It should be a later product mode,
not the implementation substrate for dictation or read-aloud.

The first release should use OpenAI's request-based Audio APIs through CoCalc's
backend:

- Speech input: `POST /v1/audio/transcriptions`, initially `gpt-transcribe`.
- Speech output: `POST /v1/audio/speech`, initially `gpt-4o-mini-tts`.
- Keep model names server-configurable and capability-reported. Do not bake a
  model list into the frontend.

OpenAI's current transcription guide recommends `gpt-transcribe` for new
general-purpose transcription. It accepts files up to 25 MB in `mp3`, `mp4`,
`mpeg`, `mpga`, `m4a`, `wav`, and `webm` formats. The Speech API supports
streamed output, and OpenAI requires a clear disclosure that its generated
voice is artificial.

Current references:

- OpenAI speech-to-text guide:
  `https://developers.openai.com/api/docs/guides/speech-to-text`
- OpenAI text-to-speech guide:
  `https://developers.openai.com/api/docs/guides/text-to-speech`
- OpenAI Realtime WebRTC guide:
  `https://developers.openai.com/api/docs/guides/realtime-webrtc`

## Product Scope

### Included

- The full chat UI in `src/packages/frontend/chat`, including project chat,
  Codex/ACP threads, external side chat, Lite, and cocalc-plus.
- iPhone Safari as a release-blocking target, plus iPad Safari, desktop Safari,
  Chrome, Firefox, and Chromium-derived browsers.
- Dictation into both rich-text and Markdown composer modes.
- Read-aloud for completed agent/AI answers, beginning with the Codex final
  response section.
- Keyboard, screen-reader, dark-mode, narrow-width, and reduced-motion support.
- Separate site kill switches for speech input and speech output.

### Not Included In The First Release

- Automatic submission after dictation.
- Always-listening microphones, wake words, or background recording.
- Full-duplex voice conversations or barge-in.
- Recording collaborators or transcribing meetings.
- Persisting source recordings or generated audio.
- Speech controls in non-chat editors.
- `packages/essential-frontend`. It intentionally does not have full chat
  parity; do not duplicate this feature there or route users to it as a mobile
  substitute.
- Browser `SpeechRecognition` or `speechSynthesis` as a hidden fallback. Their
  behavior, voices, privacy, and browser support differ enough that fallback
  would create a second untested product.

## User Experience

### Dictation

Add an icon-only microphone control to the existing responsive composer action
area in `src/packages/frontend/chat/composer.tsx`. It must not force the mobile
composer to become narrower. On a narrow screen it belongs with the existing
compact controls, not beside the full-width Send button.

States:

- **Idle:** `Dictate message`.
- **Requesting permission:** short pending state after the user's click.
- **Recording:** unmistakable active state, elapsed time, Stop, and Cancel.
- **Transcribing:** spinner/status while preserving the current draft.
- **Inserted:** focus and selection restored around the inserted text.
- **Error:** actionable message; the existing draft remains unchanged.

Use click-to-start and click-to-stop. Do not require press-and-hold. Stop
automatically at the configured duration limit and when the recorder reports a
fatal interruption. Cancel must stop every `MediaStreamTrack`, discard chunks,
and make no provider request.

Insertion semantics:

- Capture the composer draft key, session token, editor mode, and selection
  when recording starts.
- On success, insert at the live selection when the same composer session is
  still active.
- If focus moved within the same draft and the original selection is no longer
  valid, insert at the current selection.
- If the user changed thread/draft while transcription was in flight, do not
  put text into the new thread. Offer `Insert into current draft` and `Copy`
  from a small recovery notice.
- Normalize surrounding whitespace without destroying Markdown structure.
- Never auto-send.

The current `ChatInputControl` only exposes `focus()`. Extend the editor control
contract with a mode-independent operation such as:

```ts
interface ChatInputControl {
  focus: () => boolean;
  insertText: (text: string, selection?: unknown) => boolean;
  captureSelection: () => unknown;
}
```

Implement this through the existing MultiMarkdownInput/Slate/CodeMirror
selection bridges. Draft string concatenation is only a fallback for an empty
composer, not the primary insertion mechanism.

Expected errors:

- `Microphone access was denied.`
- `No supported audio recording format is available in this browser.`
- `No speech was detected.`
- `The recording is too long.`
- Credential, allowance, rate-limit, and provider-unavailable errors using the
  same terminology as the rest of CoCalc AI settings.

### Read Aloud

Add a `Read aloud` action next to Copy on a completed Codex final response. Once
the behavior is stable, expose the same action for other completed AI messages.
Do not read tool activity, status events, diffs, or hidden agent context.

Playback must not be tied to the visibility of the original message action.
After activation, show a compact player anchored immediately above the chat
composer:

- Play/pause.
- Stop and release audio resources.
- Progress and elapsed/remaining time when browser metadata permits it.
- Playback speed with a small, bounded set such as 0.75x, 1x, 1.25x, 1.5x,
  and 2x.
- A short title derived from the message/thread, not the entire answer.
- A visible and accessible `AI-generated voice` disclosure.

Only one chat speech player may be active per browser tab. Starting another
message stops the first. Navigating to another project or closing the chat
stops playback and revokes object URLs.

Do not send raw Markdown directly to TTS. Add a deterministic
`markdownToSpeechText` transformation using the existing Markdown parser or
syntax tree:

- Preserve headings, paragraphs, list order, quotations, inline code, and link
  labels in a speakable form.
- Omit raw URLs when a link has a label.
- Skip images and internal CoCalc URI targets.
- Announce and omit long fenced code blocks by default; preserve short inline
  code and short blocks.
- Remove tool/activity chrome that is not part of the final answer.
- Collapse visual-only punctuation without rewriting the answer's meaning.

Speech endpoint input is bounded, so split long answers at paragraph or
sentence boundaries. Generate one chunk at a time and prefetch at most the next
chunk. This bounds memory and provider spend when a user stops early. Keep
generated bytes only in memory for the current tab, keyed by message content,
voice, speed/instructions, and model; revoke every object URL on eviction.

Use a broadly playable response format such as MP3 for the first release.
OpenAI can stream Speech API output, but a complete bounded chunk over typed
Conat is simpler and should ship first. If measured time-to-first-audio is poor,
add a purpose-built streaming response transport rather than encoding stream
events into ordinary RPC results.

iOS Safari may decline delayed playback after an asynchronous network request.
The implementation must test this on a physical iPhone. If playback cannot
begin from the original click, transition to an explicit `Ready - tap to play`
control; do not use autoplay workarounds that create surprising audio.

## Browser Recording

Use `navigator.mediaDevices.getUserMedia({ audio: true })` and
`MediaRecorder`. Request permission only from a direct user action.

Negotiate the recorder format at runtime with `MediaRecorder.isTypeSupported`
instead of assuming Chrome's WebM output. Prefer a small ordered set containing
Opus/WebM and MP4/AAC candidates accepted by the backend. Send the actual MIME
type and a matching extension.

Initial CoCalc limits:

- Maximum duration: 90 seconds. Show a countdown for the final 10 seconds.
- Maximum encoded upload: 10 MB, checked in both browser and backend.
- One recording and one transcription request per browser tab.
- A server-side per-account rate limit, with project included in the audit
  dimensions.

Handle `visibilitychange`, track `ended`, recorder errors, route changes, and
component unmount. An interrupted recording should be recoverable when a valid
blob exists, but it must never continue invisibly.

## Backend Architecture

### Authority And API Placement

Speech is an account-facing AI service. The account's home bay should own
credential selection, allowance checks, provider calls, and usage recording.
When a request carries a `project_id`, the service must route the project policy
and collaborator authorization check to the project's owning bay. It must not
assume the browser's connected bay has authoritative project state.

Add authenticated typed methods to the browser-facing hub system API, with
names along these lines:

```ts
transcribeChatAudio({
  project_id?: string;
  path?: string;
  thread_id?: string;
  content_type: string;
  filename: string;
  audio: Uint8Array;
  duration_ms?: number;
  language_hints?: string[];
}): Promise<{
  text: string;
  model: string;
  detected_languages?: string[];
}>;

synthesizeChatSpeech({
  project_id?: string;
  path?: string;
  thread_id?: string;
  message_id: string;
  text: string;
  voice?: string;
  speed?: number;
}): Promise<{
  audio: Uint8Array;
  content_type: string;
  model: string;
}>;
```

Use `Uint8Array`, not base64. Typed Conat's MessagePack transport preserves
binary data and already falls back from its fast-RPC path when a request is too
large. Keep each request comfortably bounded anyway. Do not put recordings in
the project filesystem or durable blob store.

Before implementation, verify request cancellation and the practical browser
Conat payload ceiling with a 10 MB test. If cancellation cannot reach an active
provider request, use short server timeouts and record that limitation; do not
pretend client cancellation refunds an already-started request.

### Credential And Funding Rules

Do not reuse `getCodexPaymentSource` blindly. It can select ChatGPT subscription
OAuth, which is a Codex-specific credential and does not imply authorization to
call OpenAI's Audio API.

Create a speech-capability resolver that reports both availability and source:

1. Project OpenAI API key, when a project context exists and policy allows it.
2. Account OpenAI API key.
3. Site OpenAI API key only when site-funded speech is explicitly enabled and
   the account passes the applicable membership/allowance policy.
4. Otherwise unavailable, with a setup action linking to AI settings.

The resolver must be shared by capability reporting and execution so the UI
cannot advertise a path the backend later rejects. Update `last_used` through
the existing routed secret helpers. Never expose a provider key to the browser.

Site-funded speech needs its own bounded policy and accounting. Existing
site-funded Codex reservations are turn-oriented and should not be silently
repurposed. Record exact provider cost, model, operation (`transcription` or
`speech`), duration or character/token basis, project, and provider request ID.
Extend the AI usage schema with media-specific dimensions instead of putting
audio or full transcripts into log fields. Decide before rollout whether this
cost consumes an existing AI allowance or a separately configured speech
allowance.

This funding decision is the only product decision that should block a broad
production rollout. It does not block development with project/account keys or
an explicitly enabled development site key.

### Provider Calls

Put provider-specific code behind a small server interface so model changes do
not leak through UI code:

```ts
interface ChatSpeechProvider {
  transcribe(opts: TranscriptionRequest): Promise<TranscriptionResult>;
  synthesize(opts: SpeechRequest): Promise<SpeechResult>;
}
```

The OpenAI implementation should:

- Use SDK-supported upload objects with the real filename and content type.
- Validate size, declared MIME type, detected container signature where
  practical, duration, text length, voice, and speed server-side.
- Use configured model aliases and explicit timeouts.
- Return normalized error codes plus safe user-facing messages.
- Dispose temporary files/buffers in `finally`.
- Never log audio bytes, generated audio, full transcripts, or message text.
- Log only operational metadata and redacted failure classes.

Generated speech must clearly be identified to the user as AI-generated. Keep
that disclosure in UI copy even when a configured provider or voice changes.

## Frontend Structure

Suggested modules:

- `src/packages/frontend/chat/audio/use-chat-audio-recorder.ts`
- `src/packages/frontend/chat/audio/dictate-button.tsx`
- `src/packages/frontend/chat/audio/use-chat-speech-player.ts`
- `src/packages/frontend/chat/audio/chat-speech-player.tsx`
- `src/packages/frontend/chat/audio/read-aloud-button.tsx`
- `src/packages/frontend/chat/audio/markdown-to-speech.ts`

Keep recording and playback state in a chat-level provider/controller, not in
an individual message. Individual composers and messages invoke that
controller. This is required for one-player-at-a-time behavior, navigation
cleanup, and a player that remains visible after its source message scrolls
away.

Do not add speech logic to generic editor components. The only generic editor
change should be the small selection/insertion control needed by chat and
potentially useful elsewhere.

The server should expose a lightweight capability result so the frontend knows
whether input/output is enabled, which source will fund it, configured duration
limits, supported MIME types, and allowed voice/speed values. Browser support
is then intersected with server capability.

## Privacy, Security, And Abuse Controls

- Audio goes from the browser to CoCalc, then to the configured provider. The
  browser never receives provider credentials.
- Show concise first-use disclosure that recording audio is sent to the
  configured AI provider for transcription.
- Read-aloud sends the selected answer text to the speech provider again; state
  this in the speech settings/help surface.
- Do not retain source or generated audio. In-memory browser caching is allowed
  only for the current tab/session.
- Do not include transcript or message content in routine logs, analytics,
  traces, crash reports, or usage records.
- Enforce signed-in account, collaborator access, project/site AI policy,
  funding eligibility, rate limits, byte limits, and timeouts on the server.
- Treat client duration and MIME metadata as hints, not trusted facts.
- Ensure repeated clicks and retries have request IDs so usage and errors can
  be reconciled without accidental duplicate charging.

## Accessibility And Mobile Requirements

- Every icon control has a stable accessible name and exposed pressed/busy
  state.
- Announce recording start/stop, transcription completion/failure, and playback
  readiness through a restrained live region.
- Recording status cannot rely on color alone.
- All actions work by keyboard without press-and-hold or drag.
- Focus returns to the composer after insertion and to the invoking message
  action after the player closes when that element still exists.
- Controls reflow at 320 CSS pixels and at 200% zoom without reducing the text
  composer width below its current mobile behavior.
- Use Ant Design and `UI_COLORS`; verify light, dark, and slate modes.
- Honor CoCalc's animation preference and reduced-motion behavior.
- Test with the software keyboard open, browser chrome collapsed/expanded,
  portrait/landscape rotation, an incoming call/audio interruption, and a
  locked/unlocked device.

Physical iPhone Safari is release-blocking. Chrome device emulation and
`safaridriver` are useful regression tools but do not establish microphone,
audio-session, or delayed-playback correctness on iOS.

## Tests

### Frontend Unit And Component Tests

- Capability intersection and unsupported-browser states.
- Permission is requested only after activation.
- MIME negotiation selects the first actually supported format.
- Stop, duration limit, track interruption, Cancel, and unmount clean up all
  media tracks and timers.
- Successful transcription inserts at selection in rich-text and Markdown
  modes without auto-sending.
- A stale composer session never receives a late transcript.
- Provider errors preserve the draft and expose a specific recovery path.
- Markdown-to-speech fixtures cover headings, lists, links, quotations, math,
  inline code, fenced code, images, and CoCalc links.
- Only one player runs; stop/navigation revokes all object URLs.
- Player controls have roles, names, keyboard behavior, focus restoration, and
  live status.

### Backend Tests

- Authentication and routed project collaborator/policy checks.
- Capability and execution use the same credential/funding resolver.
- ChatGPT OAuth alone is not reported as Audio API capability.
- Unsupported MIME, invalid container, oversized body, excessive duration,
  invalid voice/speed, excessive TTS text, and rate limits are rejected before
  a provider call.
- OpenAI transcription and speech calls receive bounded, correctly named
  inputs.
- Temporary resources are removed after success, timeout, cancellation, and
  provider failure.
- Usage is recorded exactly once without content or credential leakage.
- Typed Conat binary round trips are tested above and below the fast-RPC
  threshold.

### Browser And Device Matrix

- Desktop Chrome, Firefox, and Safari: permission, record, insert, generate,
  play/pause, stop, and navigation cleanup.
- iPhone Safari: the same flow with the software keyboard and real microphone.
- iPad Safari in portrait and split view.
- Narrow and desktop screenshots in light, dark, and slate modes.
- Denied permission, missing key, exhausted allowance, offline transition, and
  provider timeout.

No automated test should upload real audio to OpenAI by default. Keep one
explicitly invoked staging smoke that uses a short synthetic fixture and checks
only the returned transcript/audio metadata.

## Delivery Sequence

### Phase 0: Capability And Funding Foundation

- Add the speech capability resolver and separate input/output feature flags.
- Decide and implement site-funded accounting semantics.
- Add typed binary transport contract tests and provider fakes.

### Phase 1: Dictation

- Extend the composer control with selection-aware insertion.
- Add recorder lifecycle and dictation UI.
- Ship behind the input flag to internal/staging users.
- Validate physical iPhone Safari before production enablement.

### Phase 2: Read Aloud

- Add deterministic Markdown-to-speech conversion and chunking.
- Add the Codex final-response action and persistent chat player.
- Validate iOS delayed playback and fall back to explicit ready/play when
  required.
- Expand to other AI messages after the final-response path is stable.

### Phase 3: Production Hardening

- Tune limits using latency, error-class, and aggregate duration metrics.
- Add settings for voice and default speed only after the basic controls are
  stable; avoid a large settings surface initially.
- Consider streamed TTS transport only if measured first-audio latency warrants
  it.

### Phase 4: Optional Realtime Voice Mode

Evaluate an explicit voice-conversation mode using OpenAI Realtime over WebRTC.
It requires a design for agent authority, tools, interruptions, transcript
persistence, handoff back to text, and spending limits. Do not infer that this
phase is complete merely because dictation and read-aloud exist.

## Acceptance Criteria

- A user can dictate into any supported chat composer, edit the result, and
  send it through the unchanged chat submission path.
- A user can read a completed Codex answer aloud and control playback after the
  source action scrolls out of view.
- Both paths work on a physical iPhone Safari and do not regress desktop chat.
- No provider credential reaches the browser.
- Audio and generated speech are bounded, transient, and absent from durable
  storage and content logs.
- Late transcription never enters the wrong thread or draft.
- Capability reporting, authorization, funding, execution, and usage recording
  agree on the same account/project authority.
- ChatGPT subscription authentication is not mistaken for Audio API access.
- The UI clearly discloses microphone data handling and AI-generated speech.
- Input and output can be disabled independently without disabling text chat.
- Full-duplex Realtime voice remains a separate, deliberate product decision.
