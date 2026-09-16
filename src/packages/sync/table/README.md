# SYNCHRONIZED TABLE --

## Defined by an object query

- Describe a query using the object-query format. The normal database adapter
  synchronizes with the backend; `synctable_no_database` also supports a table
  whose state is supplied by its client without a central database.
- The client and query implementation determine persistence; a SyncTable
  alone is not proof that data has reached durable storage.

## Methods

- Use the exported `synctable(query, options, client, throttle_changes, use_cache)`
  factory when cache/reference management is wanted. The `SyncTable` constructor
  also requires options and a compatible client; a query alone is insufficient.

- set(map): Set the given keys of map to their values; one key must be
  the primary key for the table. NOTE: Computed primary keys will
  get automatically filled in; these are schema keys where the set query
  looks like this, say:
  (obj, db) -> db.sha1(obj.project_id, obj.path)
- get(): Current value of the query, as an immutable.js Map from
  the primary key to the records, which are also immutable.js Maps.
- get(key): The record with given key, as an immutable Map.
- get(keys): Immutable Map from given keys to the corresponding records.
- get_one(): Returns one record as an immutable Map (useful if there
  is only one record)

- close(): Frees up resources, stops syncing, don't use object further

## Events

- 'change', [array of string primary keys] : fired any time the value of the query result
  changes, _including_ if changed by calling set on this object.
  Also, called with empty list on first connection if there happens
  to be nothing in this table. If the primary key is not a string it is
  converted to a JSON string.
- 'disconnected': fired when table is disconnected from the server for some reason
- 'connected': fired when table has successfully connected and finished initializing
  and is ready to use
- 'has-uncommitted-changes', boolean: reports changes to local pending-save state.
  There is no generic 'saved' event in the current class; use its save API and
  the relevant persistence layer's acknowledgement for the required guarantee.

## States

The current `get_state()` values are `disconnected`, `connected`, and `closed`.
Initialization and reconnection take place while disconnected; `connecting`
and `reconnecting` are not separate state values in the current class.

- `disconnected`: the table is not initialized with a live changefeed. Local
  pending changes and reconnect behavior depend on its client adapter.
- `connected`: initialized and receiving updates.
- `closed`: terminal state after cleanup. Connection setup or fatal save errors
  can also close the table; do not wait forever assuming only your own explicit
  `close()` call can end it.

For a cached table, `close()` releases a reference. Final teardown occurs when
no references remain; it attempts to save pending changes, then frees resources.
It does not guarantee that a final save succeeded. See
[synctable.ts](./synctable.ts) and [global-cache.ts](./global-cache.ts).

## Worry

What if the user does a set and connecting (or reconnecting)
takes a long time, e.g., suspend a laptop, then resume?
The changes may get saved... a month later. For some things,
e.g., logs, this could be fine. However, on reconnect, the first
thing is that complete upstream state of table is set on
server version of table, so reconnecting user only sends
its changes if upstream hasn't changed anything in
that same record.

## Representation

We represent synchronized tables by an immutable.js mapping from the primary
key to the object. Since PostgresQL primary keys can be compound (more than
just strings), e.g., they can be arrays, so we convert complicated keys to their
JSON representation. A binary object doesn't make sense here in pure javascript,
but these do:

      string, number, time, boolean, or array

Everything automatically converts fine to a string except array, which is the
main thing this function deals with below.

### Notes

1. RIGHT NOW: This should be safe to change at
   any time, since the keys aren't stored longterm.
   If we do something with localStorage, this will no longer be safe
   without a version number.

2. Of course you could use both a string and an array as primary keys
   in the same table. You could evily make the string equal the json of an array,
   and this _would_ break things. We are thus assuming that such mixing
   doesn't happen. An alternative would be to just _always_ use a _stable_ version of stringify.

3. We use a stable version, since otherwise things will randomly break if the
   key is an object.
