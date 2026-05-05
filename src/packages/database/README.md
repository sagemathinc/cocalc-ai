# @cocalc/database

This package connects the hub and nextjs servers to the PostgreSQL database, and implements some nontrivial functionality to support these servers. In particular:

- It implements the central user-query and database access layer used by the hub and server packages.
- It still supports raw PostgreSQL `LISTEN` / `NOTIFY` queries for a small number of targeted coordination paths and tests, but the old database-backed changefeed / `db.synctable` runtime path has been removed.

## Development

See [DB_DEVELOPMENT.md](./DB_DEVELOPMENT.md) for architecture overview, testing guidelines, and modernization patterns.

**WARNING**: This is the single scariest chunk of CoffeeScript left in CoCalc!

## Experimental PGlite

PGlite is opt-in via `COCALC_DB=pglite`. For local tests in this package:

```sh
COCALC_TEST_USE_PGLITE=1 pnpm test
```

Optionally set `COCALC_PGLITE_DATA_DIR` to a directory (or `memory://`) for storage.
