/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// PostgreSQL extension methods for synctable functionality
// Wrapper methods that delegate to implementation functions.

import type { CB } from "@cocalc/util/types/callback";

import type { PostgreSQL } from "../postgres";
import type {
  ChangefeedOptions,
  ChangefeedSelect,
  SyncTableOptions,
} from "../postgres/types";
import type { Changes } from "../postgres/changefeed/changefeed";

import {
  _ensure_trigger_exists,
  _listen,
  _notification,
  _stop_listening,
  changefeed,
  synctable,
} from "./methods-impl";
import type { SyncTable } from "./synctable";

type PostgreSQLConstructor = new (...args: any[]) => PostgreSQL;

/**
 * Extend PostgreSQL class with synctable functionality
 */
export function extend_PostgreSQL<TBase extends PostgreSQLConstructor>(
  base: TBase,
): TBase {
  return class PostgreSQL extends base {
    _listening?: Record<string, number>;

    _ensure_trigger_exists(
      table: string,
      select: ChangefeedSelect,
      watch: string[],
      cb: CB,
    ) {
      return _ensure_trigger_exists(this, table, select, watch, cb);
    }

    _listen(
      table: string,
      select: ChangefeedSelect,
      watch: string[],
      cb?: CB<string>,
    ) {
      return _listen(this, table, select, watch, cb);
    }

    _notification(mesg: { channel: string; payload: string }) {
      return _notification(this, mesg);
    }

    _stop_listening(
      table: string,
      select: Record<string, string>,
      watch: string[],
      cb?: CB,
    ) {
      return _stop_listening(this, table, select, watch, cb);
    }

    synctable(opts: SyncTableOptions): SyncTable | undefined {
      return synctable(this, opts);
    }

    changefeed(opts: ChangefeedOptions): Changes | undefined {
      return changefeed(this, opts);
    }
  };
}
