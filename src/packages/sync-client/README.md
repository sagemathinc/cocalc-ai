# @cocalc/sync-client

This is the Node.js client for the legacy project WebSocket synchronization
path. [lib/connect-to-project.ts](./lib/connect-to-project.ts) uses Primus,
`API_SERVER`, and an API key to connect to `<project_id>/raw/.smc/ws`. That
transport is distinct from the current Conat client; the presence of this
package does not establish that a hosted deployment exposes the legacy route.

The client supplies synchronization plumbing rather than a complete notebook
or editor API. The former pointer to `@cocalc/compute` refers to a removed
package. For current integrations, start with the typed
[CoCalc CLI workflows](../docs/src/content/cli-workflows.ts) and the
[Jupyter package](../jupyter/README.md), using the source appropriate to the
running deployment.
