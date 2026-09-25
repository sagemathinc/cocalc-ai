# Live voice beta

Live voice is available in the iOS app and browser chat behind
`COCALC_LIVE_VOICE_ENABLED=1` on account-home bays. Paid members can use the
site-funded allocation while they have 5-hour and 7-day allowance remaining.
Free members can use their own account or project OpenAI key. The
administrator-only development gate is `COCALC_LIVE_VOICE_DEV=1`.

The server creates GPT-Live WebRTC sessions. Audio travels directly between
the client and OpenAI. The account-home bay owns admission, the two-minute
application deadline, a 25-second heartbeat lease, and site-funded usage
accounting. It reserves two minutes of usage before a site-funded call and
persists the reservation until provider closure is confirmed. A sideband
listens for `session.closed`; missing confirmation leaves the lease open for
retry and operator attention. A creation response lost before the provider ID
is known cannot be safely retried and requires manual reconciliation. The
deadline is **not** a provider monetary cap; any provider duration beyond the
reservation is logged as an overage for operators.

Starts are limited per account, OpenAI credential, and bay. Ended session rows
are pruned after 30 days; unresolved rows are retained. Spoken delegations
are serialized so each gets a separate durable chat message ID. Calls bind to
one selected agent thread and stop when that thread changes. The mobile and
browser voice tray share a “How this works” explanation covering provider
data, ordinary spoken task authority, on-screen approvals, and dictation.

Before enabling the beta beyond the current private testers, verify closure
and accounting with a real key across disconnect, hub restart, credential
rotation, rejected creation, and timeout cases. In particular, validate the
provider's behavior when a client keeps WebRTC alive after CoCalc's deadline.

[OpenAI's session lifecycle guide](https://developers.openai.com/api/docs/guides/live-conversations)
defines `session.closed` as the finalization confirmation. Its
[WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc)
describes client and sideband connection lifecycles. The REST hangup endpoint
is documented for SIP calls, so it is not used as a WebRTC closure guarantee.
