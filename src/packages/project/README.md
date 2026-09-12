# CoCalc Project Runtime

This package implements the Node.js services inside a CoCalc project: Conat
APIs, terminal execution, Jupyter kernels, file operations, and the internal
HTTP/WS app proxy. It is part of the CoCalc-AI monorepo and is normally launched
by the selected project runtime rather than installed as a standalone service.

## Connections and configuration

- `COCALC_PROJECT_ID` identifies the project. `COCALC_USERNAME` defaults to `user`.
- `COCALC_DATA_DIR` takes precedence over `DATA` for runtime metadata. The parent
  runtime supplies the data location; without either override, shared backend
  resolution uses `<CoCalc root>/data`.
- The daemon connects to Conat using the configured address and project
  credentials. [conat/connection.ts](./conat/connection.ts) owns that connection;
  [conat/index.ts](./conat/index.ts) registers project services.
- The app proxy uses `COCALC_PROXY_PORT` when supplied; its code default is 80
  for a root process and 8080 otherwise. `COCALC_PROXY_HOST` defaults to loopback.
  These are internal runtime settings, not instructions to expose an
  unauthenticated port publicly. See [HTTP proxying](../../../docs/http-proxy.md).

[servers/init.ts](./servers/init.ts) starts Conat services and the app proxy.
The old description of separate `HUB_PORT` and `CLIENT_PORT` daemon listeners
belongs to the earlier architecture and does not describe this initialization
path. A remaining use of `HUB_PORT` by app-server helpers does not restore those
old listeners.
