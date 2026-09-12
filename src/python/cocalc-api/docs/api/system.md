# Account system calls

`hub.system.ping()` accepts a valid account API key.
`hub.system.get_names(account_ids)` additionally requires `account:read`.
The client also contains `user_search()`, but its `system.userSearch` RPC is
not allowed by the current HTTP hub bridge.

`get_names()` returns a dictionary keyed by account ID, with account name and
profile information as values. The client's `list[str]` return annotation is
stale; do not treat the result as a list of names.

::: cocalc_api.hub.System.ping

::: cocalc_api.hub.System.get_names
