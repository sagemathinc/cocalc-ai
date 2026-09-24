# Live voice beta path

The current live-voice implementation is a development preview. `server/ai/live-voice.ts` admits only administrators when `COCALC_LIVE_VOICE_DEV=1`, requires an account or project OpenAI key, and limits a session to two minutes. The mobile client uses WebRTC and delegates work to the existing agent thread, but the preview does not charge CoCalc's site-funded AI allowance. Its local dollar estimate is not a usage ledger. This is the main release gap.

## Product decisions

1. **Eligibility and funding.** Default to site-funded voice for paid memberships with available allowance. Do not expose site-funded live voice to free memberships. Decide whether a free user may explicitly opt in with their own API key, and whether a paid user's own key can be selected instead of site funding. Enforce the choice on the account-home bay, never only in the client.
2. **Allowance display.** Show only the server's 5-hour and 7-day remaining percentages and reset times, matching the existing web AI usage meters. Do not expose raw usage units, dollars, provider rates, or the global pool. Refresh when a call ends and while it is active. Say clearly when delegated agent work uses a different payment source.
3. **Call limits.** Keep the initial two-minute cap until reservation, settlement, and disconnect behavior are verified. Decide whether to lengthen it after measuring real usage and support load. A call consumes allowance during silence and while the backend agent works; ending a call must leave accepted agent work running in chat.
4. **Browser scope.** Build the funding and session service once. Add a browser WebRTC adapter and controls in the web chat after the funded mobile flow is reliable. Browser voice is desirable, but the mobile beta should not depend on that second UI being complete.

## Engineering gates

1. Replace the development-only admission with account-home-bay eligibility, site-key selection, an explicit feature flag, and a durable per-account session lease. Keep project collaboration checks and server-controlled session creation.
2. Reserve the maximum possible cost of the capped session against both account usage windows and the site-wide pool before creating the provider session. Extend the existing speech reservation/usage ledger for live sessions, with unique request IDs, expiry cleanup, and idempotent settlement. Include the provider's WebRTC initialization charge in the cap accounting; do not add it twice to a running session.
3. Observe cumulative `session.usage.updated` and final `session.closed` usage on a trusted server-side attachment. Settle the reservation using confirmed provider seconds. If final usage is unavailable, use a conservative bounded elapsed-time fallback and mark it for reconciliation. The current mobile close path stops media and the data channel immediately, so it cannot serve as the billing source.
4. Return funding source and allowance percentages from the hub. Replace the preview's dollar text with the two allowance meters, call duration, mute/end controls, and a short note that agent work may continue after hangup. Give exhausted/free users a clear disabled state rather than silently hiding the control.
5. Exercise the full path on a real iPhone: paid account, exhausted allowance, free account, microphone denial, backgrounding, lost network, repeated start, provider failure, and accepted agent work finishing after hangup. Verify usage in both windows and cleanup after a server restart. Then build and test a standalone app containing the new native code.
6. Reuse the server contract for a browser WebRTC client. Test permission and playback behavior in a real browser on HTTPS, including tab close and page navigation.

## Code map

- [`server/ai/live-voice.ts`](../server/ai/live-voice.ts): current preview session admission, provider create/hangup, and lease cleanup.
- [`server/ai/chat-speech-reservations.ts`](../server/ai/chat-speech-reservations.ts), [`server/ai/site-funded-speech-reservations.ts`](../server/ai/site-funded-speech-reservations.ts), and [`server/ai/usage-status.ts`](../server/ai/usage-status.ts): existing site-funded speech accounting and allowance windows to extend.
- [`conat/hub/api/live-voice.ts`](../conat/hub/api/live-voice.ts): typed client/server contract.
- [`mobile/src/live/native.ts`](src/live/native.ts): native WebRTC and microphone lifecycle.
- [`mobile/src/live/use-live.ts`](src/live/use-live.ts): React state, captions, session lifecycle, and delegation to the selected agent thread.
- [`mobile/src/live/controls.tsx`](src/live/controls.tsx): call UI; currently preview-oriented.

[OpenAI's GPT-Live cost documentation](https://developers.openai.com/api/docs/guides/voice-latency-cost) specifies duration-based billing, including silence and backend wait time. [Session lifecycle documentation](https://developers.openai.com/api/docs/guides/live-conversations) defines cumulative usage events and final usage on `session.closed`; [WebRTC documentation](https://developers.openai.com/api/docs/guides/voice-webrtc) covers browser support. Confirm the provider account's actual model access and current rate before enabling site funding. Backend agent usage is charged separately from voice duration.
