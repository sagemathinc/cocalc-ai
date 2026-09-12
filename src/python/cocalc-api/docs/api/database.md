# Legacy database wrapper

The client still has `hub.db.query()`, but its `db.userQuery` RPC is not
allowed through the current HTTP hub bridge. Its old examples for editing
account or project records are not a supported account-API-key workflow.

Use an explicit supported operation from the
[HTTP API reference](https://cocalc.ai/docs/api/http-api) or
[CoCalc CLI](https://cocalc.ai/docs/cli/getting-started).
See the [compatibility guide](../index.md) for the Python calls accepted by
the current bridge.
