This directory contains the lite-side implementation of Codex ACP (Agent Control Protocol). It wires the Codex agent to CoCalc’s messaging fabric, persists streamed events, and mirrors them into the chat syncdb so the frontend sees live progress and the final turn result.

Key pieces:

- `index.ts` boots the ACP server for lite mode and streams results into chat via `ChatStreamWriter`.
- `ChatStreamWriter` uses bounded ephemeral AStreams for live log updates and
  project-scoped AKV storage for replay. SQLite records track turns, queues,
  sessions, workers, and interrupts; those are distinct from live event delivery.
- Tests already exist in [**tests**](./__tests__), including chat writers,
  interrupts, and worker recovery. The project-host also reuses this directory;
  the `lite` package location does not mean every caller is single-user.
