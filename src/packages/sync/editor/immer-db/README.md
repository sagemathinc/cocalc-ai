## ImmerDB (sync/editor/immer-db)

ImmerDB is a drop-in alternative to the legacy `SyncDB` that uses patchflow’s
`DbDocumentImmer` under the hood. It exposes the same SyncDoc API (primary
keys, string columns, `get_one`, etc.) but surfaces plain JavaScript/immer
objects instead of Immutable.js records.

- `ImmerDB` lives alongside `SyncDB`; both operate on the same on-disk syncdb
  table/patches.
- Use `ImmerDB` when you want a plain-object view for easier integration with
  immer/POJO state and reduced memory overhead.
- Types live in `sync/editor/immer-db` and mirror `sync/editor/db` (opts,
  `ImmerDBDocument`). The package index exports the parser as `immer_from_str`;
  `from_str` is the internal name in `doc.ts`.

Migration tip: existing consumers of `SyncDB` can swap to `ImmerDB` without
changing the underlying data; only in-memory representation differs.
