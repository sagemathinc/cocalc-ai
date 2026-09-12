# Lite and project-host SQLite services

This directory is in active use. [user-query.ts](./user-query.ts) implements the
local query/changefeed adapter, initialized by [../api.ts](../api.ts).
[database.ts](./database.ts) also supplies local persistence to project-host
services.

ACP state uses [acp-database.ts](./acp-database.ts) and the accompanying turn,
queue, session, worker, automation, and interrupt modules. Its database path
and legacy migration are separate concerns from the general query database;
use those source owners when investigating retained state. This is not an
unused replacement that can be deleted without affecting running services.
