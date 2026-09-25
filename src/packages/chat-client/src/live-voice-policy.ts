/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Keep the browser and mobile explanations of voice data and authority aligned.
export const LIVE_VOICE_POLICY = [
  {
    title: "Live voice",
    text: "Your microphone audio goes directly to OpenAI GPT-Live. At the start of a call, CoCalc also sends up to eight recent completed messages from this agent thread (up to 900 characters each) as context. During the call, short excerpts of agent replies and generic task status may go to OpenAI. Raw submission errors are not sent. CoCalc requests that OpenAI not store the voice session.",
  },
  {
    title: "Spoken tasks and approvals",
    text: "Live voice posts spoken requests to the selected CoCalc agent as ordinary messages from you, without a separate Send tap. These can start ordinary agent work, including work with side effects, and that work may continue after the call ends. Voice does not press on-screen approval controls or perform fresh authentication; actions requiring those controls still need you to use them on screen. Review sensitive actions on screen.",
  },
  {
    title: "Dictate message",
    text: "Dictation sends only your short recording through CoCalc to OpenAI for transcription. The resulting text appears in the composer for you to review and send yourself. Dictation does not start a live call or send recent chat messages to GPT-Live.",
  },
] as const;
