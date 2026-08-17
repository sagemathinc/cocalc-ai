# CoCalc Chat Client

`@cocalc/chat-client` contains UI-independent chat behavior shared by CoCalc
clients. It must remain usable by web, React Native, and agent clients without
depending on React, the DOM, Redux, browser storage, or backend-only modules.

## Project Chat Sessions

The `project-chat-session` service is the bounded project-host data-plane
protocol for interactive chat. A client opens a session for one chat document
and selected thread, receives an authoritative recent snapshot, and then
follows a short-lived ephemeral update stream.

The protocol intentionally:

- loads only a bounded recent message window, initially 30 messages;
- returns message contents only for the selected thread;
- includes thread metadata without unrelated thread message contents;
- strips raw ACP events and bounds projected activity Markdown;
- routes directly between an authorized client and the owning project host;
- rechecks project collaboration when opening and using a session; and
- treats server sessions and update streams as disposable resources.

`RemoteHeadlessChatClient` owns session recreation. It retains the selected
thread and expanded history limit, replaces its state with a fresh
authoritative snapshot, resets the server revision watermark, and then resumes
live updates. Product UIs should call `reconnect` for lifecycle events such as
returning from a suspended mobile application; they should not implement the
wire lifecycle independently.

The project-host implementation is deliberately product-neutral. Essential,
mobile, and agent clients may use it, but product-specific UI policy must stay
outside the protocol package.
