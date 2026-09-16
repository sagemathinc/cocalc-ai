This API gets called from various places:

- a browser frontend (mostly):
  see packages/frontend/conat/client.ts
- a project
  see packages/project/conat/hub.ts
- server-side consumers, including the HTTP API handlers in
  `packages/http-api`; the active HTTP API does not require Next.js

This API is _implemented_ in two places:

- the main hub itself in packages/server/conat/api

- in lite a minimal version is implemented in packages/lite/hub/api.ts
