/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Keep the browser and mobile explanations of voice data and authority aligned.
export const LIVE_VOICE_POLICY = [
  {
    title: "Live voice",
    text: "Your microphone audio goes directly to OpenAI GPT-Live. At the start of a call, CoCalc also sends up to eight recent completed messages from this agent thread (up to 900 characters each) as context. During the call, bounded excerpts from the compact, user-visible agent-message preview and the turn state may go to OpenAI. Raw tool output, the full activity stream, hidden reasoning, and submission errors are not sent in progress updates. CoCalc requests that OpenAI not store the voice session.",
  },
  {
    title: "Spoken tasks and approvals",
    text: "Progress questions are answered from the latest visible turn report without sending a new Codex request. Spoken instructions go to the selected CoCalc agent as ordinary messages from you, without a separate Send tap. While a turn runs, instructions are sent as guidance to that turn; otherwise they may start new work. This work may have side effects and continue after the call ends. Voice does not press on-screen approval controls or perform fresh authentication; actions requiring those controls still need you to use them on screen. Review sensitive actions on screen.",
  },
  {
    title: "Dictate message",
    text: "Dictation sends only your short recording through CoCalc to OpenAI for transcription. The resulting text appears in the composer for you to review and send yourself. Dictation does not start a live call or send recent chat messages to GPT-Live.",
  },
] as const;
